// walletProcess.js
const logger = require('./src/logger');
const setupProviderAndWallet = require('./walletSetup');
const { stakeTokens, withdrawAndClaim, claim,getStakedAmount } = require('./src/staking');
const { claimFaucetWithRetry } = require('./src/faucet');
const { depositSFI, withdrawSFI,getSFIBalance,getWSFIBalance } = require('./src/depositSFI');
const { crossChainTransferWithRetry } = require('./src/crossChainTransfer');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));


function getRandomAmount(min, max) {
    return Math.random() * (max - min) + min;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

async function runWalletOperations(walletIndex) {
    const { wallet, provider } = setupProviderAndWallet(walletIndex);
    const address = wallet.address;

    try {
        // logger.info(`开始处理钱包 ${walletIndex} (${address})`);
        // logger.info(`领水： ${walletIndex} (${address})`);
        // const result = await claimFaucetWithRetry(address);
        // switch(result.status) {
        //     case 'success':
        //         logger.info('水龙头领取成功', result.data);
        //         break;
        //     case 'already_claimed':
        //         logger.warn('已经领取过水龙头', result.message);
        //         break;
        //     case 'failed':
        //         logger.error('水龙头领取失败', result.message);
        //         break;
        //     default:
        //         logger.info('未知状态', result);
        // }
        // logger.info(`钱包 ${walletIndex} (${address}) 领水操作完成，等待10秒后继续下一步...`);
        // await delay(10000);
        // 1. 跨链操作
        for (let i = 0; i < 5; i++) {
            const amount = getRandomAmount(0.05, 0.15);
            await crossChainTransferWithRetry(wallet, address, amount);
            logger.info(`跨链第 ${i+1}次: 跨链金额:${amount} SFI`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒延迟
        }
        
        // 2. SFI 和 WSFI 转换
        logger.info("开始WSFI-WSFI兑换")
        async function convertSFItoWSFI() {
            const sfiBalance = await getSFIBalance(wallet);
            const amountToConvert = sfiBalance * 0.9;
            await depositSFI(wallet, amountToConvert);
        }

        async function convertWSFItoSFI() {
            const wsfiBalance = await getWSFIBalance(wallet);
            await withdrawSFI(wallet, wsfiBalance);
        }

        await convertSFItoWSFI();
        await convertWSFItoSFI();
        await convertSFItoWSFI();
        await convertWSFItoSFI();
        await convertSFItoWSFI();

         // 3. 质押
         const wsfiBalance = await getWSFIBalance(wallet);
         const amountToStake = wsfiBalance * 0.9;
         const halfStake = amountToStake / 2;
        
         logger.info(`进行第一次质押，质押 ${halfStake} WSFI`);
         await stakeTokens(wallet, halfStake);
         logger.info(`已成功质押`);
         await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒延迟
        
         logger.info(`进行第二次质押，质押 ${halfStake} WSFI`);
         await stakeTokens(wallet, halfStake);
         logger.info(`已成功质押 `);

        // 4. 领取奖励
        logger.info("第一次claim");
        await claim(wallet);
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒延迟

        logger.info("第二次claim");
        await claim(wallet);

         // 5. 解除质押
         const stakedAmount = Math.round((Math.random() * 0.4 + 0.1) * 10) / 10;
         logger.info(`开始解除质押，数量为 ${stakedAmount} WSFI`);
         await withdrawAndClaim(wallet, stakedAmount);
         logger.info("解除质押成功")
 
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
