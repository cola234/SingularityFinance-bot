// walletProcess.js
const ethers = require('ethers');
const logger = require('./src/logger');
const erc20ABI = require('./src/ABI/ERC20.json');
const setupProviderAndWallet = require('./walletSetup');
const { stakeTokens, withdrawAndClaim, claim, getStakedAmount } = require('./src/staking');
const { claimFaucetWithRetry } = require('./src/faucet');
const { depositSFI, withdrawSFI, getSFIBalance, getWSFIBalance } = require('./src/depositSFI');
const { crossChainTransferWithRetry } = require('./src/crossChainTransfer');
const { 
    swapExactETHForTokens, 
    swapExactTokensForETH,
    swapExactTokensForTokens,
    addLiquidity,
    addLiquidityETH,
    removeLiquidity,
    removeLiquidityETH,
    getAmountsOut,
    getTokenBalance,
    getPair,
    DEX_CONTRACT_ADDRESS  
} = require('./src/DEX');

// 常量定义
const RATIOS = {
    // SFI分配
    SFI_TO_SWAP: 0.05,    // 8% SFI兑换AIMM
    SFI_TO_WSFI: 0.92,    // 92% SFI转WSFI
    
    // WSFI分配
    WSFI_TO_SWAP: 0.05,   // 8% WSFI兑换AIMM
    WSFI_TO_STAKE: 0.03,  // 5% 单次质押（总共10%）
    WSFI_TO_LP: 0.09      // 约12% 用于LP
};

const WSFI_THRESHOLD = 4;  // 低于4 WSFI时领水
const SFI_ADDRESS = "0x34Be5b8C30eE4fDe069DC878989686aBE9884470";
const WSFI_ADDRESS = "0x6dC404EFd04B880B0Ab5a26eF461b63A12E3888D";
const AIMM_ADDRESS = "0xAa4aFA7C07405992e3f6799dCC260D389687077a";
const LP_ADDRESS = "0xcc922d9E5DaB15513c6500B67459502A6C2e0F3C";

async function runWalletOperations(walletIndex) {
    const { wallet, provider } = setupProviderAndWallet(walletIndex);
    const address = wallet.address;

    try {
        logger.info(`开始处理钱包 ${walletIndex} (${address})`);

        // 1. 检查WSFI余额，如果低于阈值则领水
        const wsfiBalance = await getWSFIBalance(wallet);
        if (wsfiBalance < WSFI_THRESHOLD) {
            logger.info(`当前WSFI余额(${wsfiBalance})低于${WSFI_THRESHOLD}，准备领水`);
            const result = await claimFaucetWithRetry(address);
            switch(result.status) {
                case 'success':
                    logger.info('水龙头领取成功', result.data);
                    break;
                case 'already_claimed':
                    logger.warn('已经领取过水龙头', result.message);
                    break;
                case 'failed':
                    logger.error('水龙头领取失败', result.message);
                    break;
                default:
                    logger.info('未知状态', result);
            }
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        // 2. 将92% SFI转换为WSFI
        const sfiBalance = await getSFIBalance(wallet);
        const sfiToConvert = sfiBalance * RATIOS.SFI_TO_WSFI;
        logger.info(`转换${sfiToConvert} SFI到WSFI`);
        await depositSFI(wallet, sfiToConvert);
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 3. 用8% SFI兑换AIMM
        const sfiToSwap = sfiBalance * RATIOS.SFI_TO_SWAP;
        logger.info(`用${sfiToSwap} SFI兑换AIMM`);
        try {
            await swapExactETHForTokens(
                wallet,
                sfiToSwap.toString(),
                30,
                [WSFI_ADDRESS, AIMM_ADDRESS],  
                ethers.constants.MaxUint256
            );
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('SFI兑换AIMM失败:', error.message);
            throw error;
        }

        // 4. 用8% WSFI兑换AIMM
        const currentWSFIBalance = await getWSFIBalance(wallet);
        const wsfiToSwap = currentWSFIBalance * RATIOS.WSFI_TO_SWAP;
        logger.info(`用${wsfiToSwap} WSFI兑换AIMM`);
        try {
            const swapTx2 = await swapExactTokensForTokens(
                wallet,
                wsfiToSwap.toString(),
                30,
                [WSFI_ADDRESS, AIMM_ADDRESS],
                "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            );
            logger.info('等待WSFI兑换AIMM交易确认...');
            await swapTx2.wait();
            logger.info('WSFI兑换AIMM交易已确认');
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('WSFI兑换AIMM失败:', error.message);
            throw error;
        }

        // 5. 第一次质押5% WSFI
        const wsfiToStake = currentWSFIBalance * RATIOS.WSFI_TO_STAKE;
        logger.info(`第一次质押${wsfiToStake} WSFI`);
        try {
            await stakeTokens(wallet, wsfiToStake);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('第一次质押失败:', error.message);
            throw error;
        }

        // 6. 第一次Claim
        logger.info("执行第一次Claim");
        try {
            await claim(wallet);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('第一次Claim失败:', error.message);
            throw error;
        }

        // 7. 第二次质押5% WSFI
        logger.info(`第二次质押${wsfiToStake} WSFI`);
        try {
            await stakeTokens(wallet, wsfiToStake);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('第二次质押失败:', error.message);
            throw error;
        }

        // // 8. 第二次Claim
        logger.info("执行第二次Claim");
        try {
            await claim(wallet);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('第二次Claim失败:', error.message);
            throw error;
        }

        // 9. 组建LP
        try {
            // 获取两个代币的余额
            const aimmBalance = await getTokenBalance(wallet, AIMM_ADDRESS);
            const wsfiBalance = await getTokenBalance(wallet, WSFI_ADDRESS);
            
            if (!aimmBalance || aimmBalance.isZero()) {
                throw new Error('AIMM余额为0，无法组建LP');
            }
            if (!wsfiBalance || wsfiBalance === 0) {
                throw new Error('WSFI余额为0，无法组建LP');
            }

            // 随机选择0.05-0.15之间的AIMM数量
            const minAimm = 0.05;
            const maxAimm = 0.15;
            const random = Math.floor(Math.random() * 1000);
            let aimmToUse = minAimm + (maxAimm - minAimm) * random / 1000;

            // 确保不超过余额的50%（使用实际数值比较）
            const aimmBalanceNumber = parseFloat(ethers.utils.formatUnits(aimmBalance, 18));
            if (aimmToUse > aimmBalanceNumber / 2) {
                aimmToUse = aimmBalanceNumber / 2;
            }

            // 计算配对需要的WSFI（WSFI:AIMM = 1:0.7）
            let wsfiForLP = aimmToUse * 10 / 7;

            // 确保不超过余额的50%
            if (wsfiForLP > wsfiBalance / 2) {
                wsfiForLP = wsfiBalance / 2;
                // 重新计算AIMM数量
                aimmToUse = wsfiForLP * 7 / 10;
            }

            // 使用3位小数进行日志输出
            logger.info(`组建LP：使用${wsfiForLP.toFixed(3)} WSFI和${aimmToUse.toFixed(3)} AIMM`);

            // 直接传入数字，addLiquidity函数内部会使用parseEther转换为最小单位
            await addLiquidity(
                wallet,
                WSFI_ADDRESS,
                AIMM_ADDRESS,
                wsfiForLP,
                aimmToUse,
                30,
                "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            );
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('添加流动性失败:', error.message);
            throw error;
        }

        // 10. 移除流动性
        try {
            // 获取LP余额
            const pair = await getPair(wallet, WSFI_ADDRESS, AIMM_ADDRESS);
            const lpToken = new ethers.Contract(pair, erc20ABI, wallet);
            const lpBalance = await lpToken.balanceOf(wallet.address);
            const lpBalanceFormatted = ethers.utils.formatEther(lpBalance);
            
            if (lpBalance.isZero()) {
                throw new Error('LP余额为0，无法移除流动性');
            }

            // 检查授权
            const allowance = await lpToken.allowance(wallet.address, DEX_CONTRACT_ADDRESS);
            if (allowance.lt(lpBalance)) {
                logger.info("正在授权LP代币...");
                const approveTx = await lpToken.approve(DEX_CONTRACT_ADDRESS, ethers.constants.MaxUint256);
                const approveReceipt = await approveTx.wait();
                logger.info(`LP代币授权成功，交易哈希: ${approveReceipt.transactionHash}`);
                
                // 再次检查授权是否成功
                const newAllowance = await lpToken.allowance(wallet.address, DEX_CONTRACT_ADDRESS);
                if (newAllowance.lt(lpBalance)) {
                    throw new Error('LP代币授权失败');
                }
            }
            
            // 从25%、50%、75%、100%中随机选择一个比例
            const percentages = [25, 50, 75, 100];
            const selectedPercentage = percentages[Math.floor(Math.random() * percentages.length)];
            const lpToRemove = lpBalance.mul(selectedPercentage).div(100);
            logger.info(`移除${selectedPercentage}%的LP，数量为${ethers.utils.formatEther(lpToRemove)}`);

            await removeLiquidity(
                wallet,
                WSFI_ADDRESS,
                AIMM_ADDRESS,
                lpToRemove,
                30  // 增加滑点到30%，因为市场波动较大
            );
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('移除流动性失败:', error.message);
            throw error;
        }

        logger.info(`钱包 ${walletIndex} 的操作已成功完成`);
        process.send(`钱包 ${walletIndex} 的操作已成功完成`);

    } catch (error) {
        logger.error(`钱包 ${walletIndex} 操作失败:`, error);
        process.send(`钱包 ${walletIndex} 操作失败: ${error.message}`);
    }
}

const walletIndex = parseInt(process.argv[2], 10);
runWalletOperations(walletIndex).catch(error => {
    logger.error(`Wallet ${walletIndex} operations failed:`, error);
    process.exit(1);
});
