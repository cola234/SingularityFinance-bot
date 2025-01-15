const ethers = require('ethers');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// 读取 ABI 文件
const wrappedSFIABI = require('E:\\B\\Jiaoben\\SingularityFinance\\src\\ABI\\WrappedSFI.json');
// WrappedSFI 合约地址
const contractAddress = '0x6dC404EFd04B880B0Ab5a26eF461b63A12E3888D';

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

async function depositSFI(wallet, amount) {
    return retryOperation(async () => {
        const provider = wallet.provider;
        const contract = new ethers.Contract(contractAddress, wrappedSFIABI, wallet);
        const amountInWei = ethers.utils.parseEther(amount.toString());

        const balance = await provider.getBalance(wallet.address);
        if (balance.lt(amountInWei)) {
            throw new Error('余额不足');
        }

        logger.info(`将SFI兑换为 ${amount} WSFI...`);
        const tx = await contract.deposit({ value: amountInWei });

        logger.info('交易已发送，等待确认...');
        const receipt = await tx.wait();
        
        logger.info(`兑换成功！交易哈希：${receipt.transactionHash}`);
        return receipt.transactionHash;
    });
}

async function getSFIBalance(wallet) {
    return retryOperation(async () => {
        const balance = await wallet.provider.getBalance(wallet.address);
        return ethers.utils.formatEther(balance);
    });
}

const WSFI_CONTRACT_ADDRESS = '0x6dC404EFd04B880B0Ab5a26eF461b63A12E3888D';
async function getWSFIBalance(wallet) {
    return retryOperation(async () => {
        const wsfiContract = new ethers.Contract(WSFI_CONTRACT_ADDRESS, wrappedSFIABI, wallet.provider);
        const balance = await wsfiContract.balanceOf(wallet.address);
        return ethers.utils.formatEther(balance);
    });
}

async function withdrawSFI(wallet, amount) {
    return retryOperation(async () => {
        const contract = new ethers.Contract(contractAddress, wrappedSFIABI, wallet);
        const amountInWei = ethers.utils.parseEther(amount.toString());

        const wSFIBalance = await contract.balanceOf(wallet.address);
        if (wSFIBalance.lt(amountInWei)) {
            throw new Error('WSFI 余额不足');
        }

        logger.info(`正在将WSFI兑换 ${amount} SFI...`);
        const tx = await contract.withdraw(amountInWei);

        logger.info('交易已发送，等待确认...');
        const receipt = await tx.wait();
        
        logger.info(`兑换成功！交易哈希：${receipt.transactionHash}`);
        return receipt.transactionHash;
    });
}

module.exports = { depositSFI, withdrawSFI, getSFIBalance, getWSFIBalance };
