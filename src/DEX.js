const ethers = require('ethers');
const logger = require('./logger');
const path = require('path');
require('dotenv').config();
const erc20ABI = require('./ABI/ERC20.json');
const wrappedSFIABI = require('./ABI/WrappedSFI.json');
const pairABI = require('./ABI/Pair.json');

// 读取 ABI 文件
const dexABI = require(path.join(__dirname, 'ABI', 'DEX.json'));

// DEX Router 合约地址
const DEX_CONTRACT_ADDRESS = '0xFEccff0ecf1cAa1669A71C5E00b51B48E4CBc6A1';
const WSFI_CONTRACT_ADDRESS = '0x6dC404EFd04B880B0Ab5a26eF461b63A12E3888D';  // 修正了校验和地址

// 辅助函数：延迟
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 重试包装函数
async function retryOperation(operation, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) {
                logger.error(`所有重试失败，最后一次错误: ${error.message}`);
                throw error;
            }
            logger.warn(`尝试 ${attempt} 失败，5秒后重试...`);
            await delay(5000);
        }
    }
}

// ETH换Token sfi换AIMM
async function swapExactETHForTokens(wallet, amountIn, slippagePercent, path, deadline) {
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
        
        // 1. 检查ETH余额
        const ethBalance = await wallet.provider.getBalance(wallet.address);
        const amountToSwap = ethers.utils.parseEther(amountIn.toString());
        if (ethBalance.lt(amountToSwap)) {
            throw new Error(`ETH余额不足，需要 ${amountIn} ETH，但只有 ${ethers.utils.formatEther(ethBalance)} ETH`);
        }

        // 2. 获取预期输出数量
        const amountsOut = await router.getAmountsOut(
            amountToSwap,
            path
        );
        
        if (!amountsOut || amountsOut.length < 2) {
            throw new Error('获取预期兑换数量失败');
        }
        
        const expectedAmount = amountsOut[1];
        logger.info(`预期可获得: ${ethers.utils.formatEther(expectedAmount)} tokens`);

        // 3. 计算滑点后的最小接受值
        const amountOutMin = expectedAmount.mul(100 - slippagePercent).div(100);
        logger.info(`设置${slippagePercent}%滑点，最低接受: ${ethers.utils.formatEther(amountOutMin)} tokens`);

        // 4. 执行兑换
        logger.info(`正在用 ${amountIn} ETH 兑换代币...`);
        const tx = await router.swapExactETHForTokens(
            amountOutMin,
            path,
            wallet.address,
            deadline,
            { value: amountToSwap }
        );

        const receipt = await tx.wait();
        logger.info(`兑换完成，交易哈希: ${receipt.transactionHash}`);
        
        // 获取交易后的代币余额
        const targetTokenContract = new ethers.Contract(path[1], erc20ABI, wallet);
        const balance = await targetTokenContract.balanceOf(wallet.address);
        logger.info(`当前代币余额: ${ethers.utils.formatEther(balance)}`);
        
        return receipt.transactionHash;
    });
}

// Token换ETH
async function swapExactTokensForETH(wallet, amountIn, slippagePercent, path, deadline) {
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
        
        // 1. 先检查余额
        const isWSFI = path[0].toLowerCase() === WSFI_CONTRACT_ADDRESS.toLowerCase();
        const tokenContract = new ethers.Contract(path[0], isWSFI ? wrappedSFIABI : erc20ABI, wallet);
        const tokenBalance = await tokenContract.balanceOf(wallet.address);
        const amountToSwap = ethers.utils.parseEther(amountIn.toString());
        if (tokenBalance.lt(amountToSwap)) {
            throw new Error(`代币余额不足，需要 ${amountIn} tokens，但只有 ${ethers.utils.formatEther(tokenBalance)} tokens`);
        }
        
        // 2. 进行授权
        logger.info("检查授权状态...");
        const allowance = await tokenContract.allowance(wallet.address, DEX_CONTRACT_ADDRESS);
        
        if (allowance.lt(amountToSwap)) {
            logger.info("正在授权DEX路由合约...");
            const approveTx = await tokenContract.approve(
                DEX_CONTRACT_ADDRESS,
                ethers.constants.MaxUint256  // 授权最大值，这样后续交易就不需要重复授权
            );
            await approveTx.wait();
            logger.info("授权成功");
        } else {
            logger.info("已有足够授权");
        }

        // 3. 获取预期输出数量
        const amountsOut = await router.getAmountsOut(
            ethers.utils.parseEther(amountIn.toString()), 
            path
        );
        
        if (!amountsOut || amountsOut.length < 2) {
            throw new Error('获取预期兑换数量失败');
        }
        
        const expectedAmount = amountsOut[1];
        logger.info(`预期可获得: ${ethers.utils.formatEther(expectedAmount)} ETH`);

        // 4. 计算滑点后的最小接受值
        const amountOutMin = expectedAmount.mul(100 - slippagePercent).div(100);
        logger.info(`设置${slippagePercent}%滑点，最低接受: ${ethers.utils.formatEther(amountOutMin)} ETH`);

        // 5. 执行兑换
        const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            ethers.utils.parseEther(amountIn.toString()),
            amountOutMin,
            path,
            wallet.address,
            deadline
        );

        const receipt = await tx.wait();
        logger.info(`兑换完成，交易哈希: ${receipt.transactionHash}`);
        
        // 获取交易后的ETH余额
        const ethBalance = await wallet.provider.getBalance(wallet.address);
        logger.info(`当前 ETH 余额: ${ethers.utils.formatEther(ethBalance)}`);
        
        return receipt.transactionHash;
    });
}

// Token换Token WSFI换AIMM（带滑点设置）
async function swapExactTokensForTokens(wallet, amountIn, slippagePercent, path, deadline) {
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
        
        // 1. 先检查余额
        const isWSFI = path[0].toLowerCase() === WSFI_CONTRACT_ADDRESS.toLowerCase();
        const tokenContract = new ethers.Contract(path[0], isWSFI ? wrappedSFIABI : erc20ABI, wallet);
        const tokenBalance = await tokenContract.balanceOf(wallet.address);
        const amountToSwap = ethers.utils.parseEther(amountIn.toString());
        if (tokenBalance.lt(amountToSwap)) {
            throw new Error(`代币余额不足，需要 ${amountIn}，但只有 ${ethers.utils.formatEther(tokenBalance)}`);
        }
        
        // 2. 进行授权
        logger.info("检查授权状态...");
        const allowance = await tokenContract.allowance(wallet.address, DEX_CONTRACT_ADDRESS);
        
        if (allowance.lt(amountToSwap)) {
            logger.info("正在授权DEX路由合约...");
            const approveTx = await tokenContract.approve(
                DEX_CONTRACT_ADDRESS,
                ethers.constants.MaxUint256
            );
            await approveTx.wait();
            logger.info("授权成功");
        } else {
            logger.info("已有足够授权");
        }

        // 3. 获取预期输出数量
        const amountsOut = await router.getAmountsOut(
            amountToSwap,
            path
        );
        
        if (!amountsOut || amountsOut.length < 2) {
            throw new Error('获取预期兑换数量失败');
        }
        
        const expectedAmount = amountsOut[1];
        logger.info(`预期可获得: ${ethers.utils.formatEther(expectedAmount)} 代币`);

        // 4. 计算滑点后的最小接受值
        const amountOutMin = expectedAmount.mul(100 - slippagePercent).div(100);
        logger.info(`设置${slippagePercent}%滑点，最低接受: ${ethers.utils.formatEther(amountOutMin)} 代币`);

        // 5. 执行兑换
        const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountToSwap,
            amountOutMin,
            path,
            wallet.address,
            deadline
        );

        logger.info('等待交易确认...');
        const receipt = await tx.wait();
        logger.info(`兑换完成，交易哈希: ${receipt.transactionHash}`);
        
        // 等待几秒让区块链状态更新
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // 获取交易后的代币余额
        try {
            const targetTokenContract = new ethers.Contract(path[1], erc20ABI, wallet);
            const balance = await targetTokenContract.balanceOf(wallet.address);
            logger.info(`当前代币余额: ${ethers.utils.formatEther(balance)}`);
        } catch (error) {
            logger.warn('获取代币余额失败，但交易已完成', error.message);
        }
        
        return tx;
    });
}

// 添加流动性 (Token + Token) WSFI和AIMM
async function addLiquidity(wallet, tokenA, tokenB, amountA, amountB, slippagePercent, deadline) {
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
        
        // 1. 检查代币余额和授权
        const tokenAContract = new ethers.Contract(tokenA, erc20ABI, wallet);
        const tokenBContract = new ethers.Contract(tokenB, erc20ABI, wallet);
        
        const amountADesired = ethers.utils.parseEther(amountA.toString());
        const amountBDesired = ethers.utils.parseEther(amountB.toString());
        
        // 检查余额
        const balanceA = await tokenAContract.balanceOf(wallet.address);
        const balanceB = await tokenBContract.balanceOf(wallet.address);
        
        if (balanceA.lt(amountADesired)) {
            throw new Error(`代币A余额不足，需要 ${amountA} tokens，但只有 ${ethers.utils.formatEther(balanceA)} tokens`);
        }
        if (balanceB.lt(amountBDesired)) {
            throw new Error(`代币B余额不足，需要 ${amountB} tokens，但只有 ${ethers.utils.formatEther(balanceB)} tokens`);
        }
        
        // 检查授权
        const allowanceA = await tokenAContract.allowance(wallet.address, DEX_CONTRACT_ADDRESS);
        const allowanceB = await tokenBContract.allowance(wallet.address, DEX_CONTRACT_ADDRESS);
        
        if (allowanceA.lt(amountADesired)) {
            logger.info("正在授权代币A...");
            const approveTxA = await tokenAContract.approve(DEX_CONTRACT_ADDRESS, ethers.constants.MaxUint256);
            await approveTxA.wait();
            logger.info("代币A授权成功");
        }
        
        if (allowanceB.lt(amountBDesired)) {
            logger.info("正在授权代币B...");
            const approveTxB = await tokenBContract.approve(DEX_CONTRACT_ADDRESS, ethers.constants.MaxUint256);
            await approveTxB.wait();
            logger.info("代币B授权成功");
        }

        // 2. 计算最小接受数量
        const amountAMin = amountADesired.mul(100 - slippagePercent).div(100);
        const amountBMin = amountBDesired.mul(100 - slippagePercent).div(100);

        logger.info(`添加流动性参数：
            - 输入代币A: ${ethers.utils.formatEther(amountADesired)} WSFI
            - 输入代币B: ${ethers.utils.formatEther(amountBDesired)} AIMM
            - 滑点容差: ${slippagePercent}%
            - 最低接受A: ${ethers.utils.formatEther(amountAMin)} WSFI
            - 最低接受B: ${ethers.utils.formatEther(amountBMin)} AIMM`);

        // 3. 添加流动性
        const tx = await router.addLiquidity(
            tokenA,
            tokenB,
            amountADesired,
            amountBDesired,
            amountAMin,
            amountBMin,
            wallet.address,
            deadline
        );

        const receipt = await tx.wait();
        logger.info(`流动性添加完成，交易哈希：${receipt.transactionHash}`);
        
        // 4. 获取LP代币余额
        const pair = await router.factory().then(factory => 
            new ethers.Contract(factory, ['function getPair(address,address) view returns (address)'], wallet)
                .getPair(tokenA, tokenB)
        );
        
        if (pair) {
            const lpToken = new ethers.Contract(pair, erc20ABI, wallet);
            const lpBalance = await lpToken.balanceOf(wallet.address);
            logger.info(`当前LP代币余额: ${ethers.utils.formatEther(lpBalance)}`);
        }
        
        return receipt.transactionHash;
    });
}

// 添加流动性 (ETH + Token)
async function addLiquidityETH(wallet, token, tokenAmount, ethAmount, slippagePercent, deadline) {
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
        
        // 1. 检查ETH余额和代币余额
        const ethBalance = await wallet.provider.getBalance(wallet.address);
        const ethToAdd = ethers.utils.parseEther(ethAmount.toString());
        if (ethBalance.lt(ethToAdd)) {
            throw new Error(`ETH余额不足，需要 ${ethAmount} ETH，但只有 ${ethers.utils.formatEther(ethBalance)} ETH`);
        }

        const tokenContract = new ethers.Contract(token, erc20ABI, wallet);
        const tokenToAdd = ethers.utils.parseEther(tokenAmount.toString());
        const tokenBalance = await tokenContract.balanceOf(wallet.address);
        if (tokenBalance.lt(tokenToAdd)) {
            throw new Error(`代币余额不足，需要 ${tokenAmount} tokens，但只有 ${ethers.utils.formatEther(tokenBalance)} tokens`);
        }

        // 2. 检查并进行授权
        const allowance = await tokenContract.allowance(wallet.address, DEX_CONTRACT_ADDRESS);
        if (allowance.lt(tokenToAdd)) {
            logger.info("正在授权代币...");
            const approveTx = await tokenContract.approve(DEX_CONTRACT_ADDRESS, ethers.constants.MaxUint256);
            await approveTx.wait();
            logger.info("授权成功");
        }

        // 3. 计算最小接受数量
        const tokenAmountMin = tokenToAdd.mul(100 - slippagePercent).div(100);
        const ethAmountMin = ethToAdd.mul(100 - slippagePercent).div(100);

        logger.info(`添加流动性参数：
            - 输入ETH: ${ethers.utils.formatEther(ethToAdd)} ETH
            - 输入代币: ${ethers.utils.formatEther(tokenToAdd)} tokens
            - 滑点容差: ${slippagePercent}%
            - 最低接受ETH: ${ethers.utils.formatEther(ethAmountMin)} ETH
            - 最低接受代币: ${ethers.utils.formatEther(tokenAmountMin)} tokens`);

        // 4. 添加流动性
        const tx = await router.addLiquidityETH(
            token,
            tokenToAdd,
            tokenAmountMin,
            ethAmountMin,
            wallet.address,
            deadline,
            { value: ethToAdd }
        );

        const receipt = await tx.wait();
        logger.info(`流动性添加完成，交易哈希：${receipt.transactionHash}`);

        // 5. 获取LP代币余额
        const weth = await router.WETH();
        const pair = await router.factory().then(factory => 
            new ethers.Contract(factory, ['function getPair(address,address) view returns (address)'], wallet)
                .getPair(token, weth)
        );
        
        if (pair) {
            const lpToken = new ethers.Contract(pair, erc20ABI, wallet);
            const lpBalance = await lpToken.balanceOf(wallet.address);
            logger.info(`当前LP代币余额: ${ethers.utils.formatEther(lpBalance)}`);
        }

        return receipt.transactionHash;
    });
}

// 移除流动性 (Token + Token)
//tokenA 为 WSFI，tokenB 为 AIMM
//liquidity 为流动性数量 根据总量计算
// 在DEX.js顶部添加这个常量
const MAX_UINT256 = ethers.constants.MaxUint256;

// 修改removeLiquidity函数，使用固定的deadline
async function removeLiquidity(wallet, tokenA, tokenB, liquidity, slippagePercent) { // 移除deadline参数
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
        
        // 1. 获取交易对地址
        const factory = await router.factory();
        const factoryContract = new ethers.Contract(factory, ['function getPair(address,address) view returns (address)'], wallet);
        const pair = await factoryContract.getPair(tokenA, tokenB);
        
        if (!pair) {
            throw new Error('交易对不存在');
        }

        // 2. 获取储备量
        const pairContract = new ethers.Contract(pair, pairABI, wallet);
        const [token0, token1] = await Promise.all([
            pairContract.token0(),
            pairContract.token1()
        ]);
        const [reserve0, reserve1] = await pairContract.getReserves()
            .then(([r0, r1]) => token0.toLowerCase() === tokenA.toLowerCase() ? [r0, r1] : [r1, r0]);

        // 3. 计算最小接收数量
        const totalSupply = await new ethers.Contract(pair, erc20ABI, wallet).totalSupply();
        
        // 计算预期接收数量（按比例）
        const expectedAmountA = liquidity.mul(reserve0).div(totalSupply);
        const expectedAmountB = liquidity.mul(reserve1).div(totalSupply);
        
        // 应用滑点
        const minAmountA = expectedAmountA.mul(100 - slippagePercent).div(100);
        const minAmountB = expectedAmountB.mul(100 - slippagePercent).div(100);
        
        logger.info(`正在移除流动性...`);
        logger.info(`LP代币地址: ${pair}`);
        logger.info(`LP数量: ${ethers.utils.formatEther(liquidity)}`);
        logger.info(`滑点: ${slippagePercent}%`);
        logger.info(`预期接收数量:`);
        logger.info(`- TokenA (${tokenA}): ${ethers.utils.formatEther(expectedAmountA)}`);
        logger.info(`- TokenB (${tokenB}): ${ethers.utils.formatEther(expectedAmountB)}`);
        logger.info(`最小接收数量:`);
        logger.info(`- TokenA: ${ethers.utils.formatEther(minAmountA)}`);
        logger.info(`- TokenB: ${ethers.utils.formatEther(minAmountB)}`);

        try {
            const tx = await router.removeLiquidity(
                tokenA,
                tokenB,
                liquidity,           // LP token数量
                minAmountA,         // tokenA最小接收数量
                minAmountB,         // tokenB最小接收数量
                wallet.address,
                ethers.constants.MaxUint256  // 使用固定的最大值作为deadline
            );

            logger.info('交易已发送，等待确认...');
            const receipt = await tx.wait();
            
            if (receipt.status === 0) {
                throw new Error('交易执行失败');
            }
            
            logger.info(`移除流动性成功！交易哈希：${receipt.transactionHash}`);
            return receipt.transactionHash;
        } catch (error) {
            // 尝试获取更详细的错误信息
            logger.error('移除流动性时发生错误:');
            logger.error(`- LP代币地址: ${pair}`);
            logger.error(`- LP数量: ${ethers.utils.formatEther(liquidity)}`);
            logger.error(`- TokenA地址: ${tokenA}`);
            logger.error(`- TokenB地址: ${tokenB}`);
            logger.error(`- 错误信息: ${error.message}`);
            if (error.data) {
                logger.error(`- 错误数据: ${error.data}`);
            }
            throw error;
        }
    });
}

// 移除流动性 (ETH + Token)
async function removeLiquidityETH(wallet, token, liquidity, amountTokenMin, amountETHMin, deadline) {
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
        
        logger.info(`正在移除ETH流动性...`);
        const tx = await router.removeLiquidityETHSupportingFeeOnTransferTokens(
            token,
            ethers.utils.parseEther(liquidity.toString()),
            ethers.utils.parseEther(amountTokenMin.toString()),
            ethers.utils.parseEther(amountETHMin.toString()),
            wallet.address,
            deadline
        );

        logger.info('交易已发送，等待确认...');
        const receipt = await tx.wait();
        
        logger.info(`移除流动性成功！交易哈希：${receipt.transactionHash}`);
        return receipt.transactionHash;
    });
}

async function getTokenBalance(wallet, tokenAddress) {
    return retryOperation(async () => {
        const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, wallet);
        const balance = await tokenContract.balanceOf(wallet.address);
        
        logger.info(`地址 ${wallet.address} 的代币余额: ${ethers.utils.formatEther(balance)}`);
        return balance;
    });
}

// 获取兑换输出数量
async function getAmountsOut(wallet, amountIn, path) {
    return retryOperation(async () => {
        const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet.provider);
        const amounts = await router.getAmountsOut(
            ethers.utils.parseEther(amountIn.toString()),
            path
        );
        return amounts.map(amount => ethers.utils.formatEther(amount));
    });
}

// 获取交易对地址
async function getPair(wallet, tokenA, tokenB) {
    const router = new ethers.Contract(DEX_CONTRACT_ADDRESS, dexABI, wallet);
    const factory = await router.factory();
    const factoryContract = new ethers.Contract(factory, ['function getPair(address,address) view returns (address)'], wallet);
    const pair = await factoryContract.getPair(tokenA, tokenB);
    if (!pair) {
        throw new Error('交易对不存在');
    }
    return pair;
}

module.exports = {
    swapExactETHForTokens,
    swapExactTokensForETH,
    swapExactTokensForTokens,
    addLiquidity,
    addLiquidityETH,
    removeLiquidity,
    removeLiquidityETH,
    getTokenBalance,
    getAmountsOut,
    getPair,
    DEX_CONTRACT_ADDRESS
};