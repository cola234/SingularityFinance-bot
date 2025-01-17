const ethers = require('ethers');
const logger = require('./logger');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function crossChainTransferWithRetry(wallet, targetAddress, amount, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await crossChainTransfer(wallet, targetAddress, amount);
            return result;
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

async function crossChainTransfer(wallet, targetAddress, amount) {
    const amountWei = ethers.utils.parseEther(amount.toString());
    const provider = wallet.provider;
    const contractAddress = '0x4200000000000000000000000000000000000016';
    // 读取 WrappedSFI ABI
    const abi = JSON.parse(fs.readFileSync(path.join(__dirname, 'ABI', 'L2ToL1MessagePasserABI.json'), 'utf8'));
    const contract = new ethers.Contract(contractAddress, abi, wallet);
    const gasLimit = 200000;
    const data = '0x';

    try {
        const balance = await provider.getBalance(wallet.address);
        if (balance.lt(amountWei)) {
            throw new Error('余额不足');
        }

        logger.info('发起跨链转账...');
        const tx = await contract.initiateWithdrawal(
            targetAddress,
            gasLimit,
            data,
            { value: amountWei }
        );

        logger.info('交易已发送，等待确认...');
        const receipt = await tx.wait();
        logger.info(`交易已确认！交易哈希: ${receipt.transactionHash}`);

        // 解析事件日志的部分保持注释状态

        return receipt.transactionHash;
    } catch (error) {
        logger.error('跨链转账失败:', error);
        throw error;
    }
}

module.exports = { crossChainTransferWithRetry };
