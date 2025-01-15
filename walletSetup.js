// walletSetup.js
const ethers = require('ethers');
const fs = require('fs');
const path = require('path');

function readPrivateKeys() {
    const privateKeyPath = path.join(__dirname, 'config', 'private_key.list');
    try {
        const data = fs.readFileSync(privateKeyPath, 'utf8');
        return data.split('\n')
            .map(key => key.trim())  // 删除每行开头和结尾的空白字符
            .filter(key => key !== '')  // 过滤掉空行
            .map(key => {
                // 删除所有空白字符，包括中间的空格
                key = key.replace(/\s/g, '');
                // 如果密钥以 '0x' 开头，则删除它
                return key.startsWith('0x') ? key.slice(2) : key;
            });
    } catch (error) {
        console.error('读取私钥失败:', error);
        return [];
    }
}

function setupProviderAndWallet(privateKeyIndex = 0) {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc-testnet.singularityfinance.ai');
    const privateKeys = readPrivateKeys();

    if (privateKeys.length === 0) {
        throw new Error('私钥文件为空！');
    }

    if (privateKeyIndex >= privateKeys.length) {
        throw new Error(`索引超出范围！. Total keys: ${privateKeys.length}`);
    }

    const privateKey = privateKeys[privateKeyIndex];
    const wallet = new ethers.Wallet(privateKey, provider);
    return { provider, wallet, totalWallets: privateKeys.length };
}

module.exports = setupProviderAndWallet;
