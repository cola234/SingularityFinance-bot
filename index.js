require('dotenv').config();
const { fork } = require('child_process');
const setupProviderAndWallet = require('./walletSetup');
const logger = require('./src/logger');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function printAuthorInfo() {
    logger.info('='.repeat(50));
    logger.info('SingularityFinance 自动任务脚本');
    logger.info('作者: 北月');
    logger.info('推特: https://x.com/beiyue66');
    logger.warn('注意: 使用此脚本请自行创建新钱包。');
    logger.warn('      作者不对因使用此脚本造成的任何损失负责。');
    logger.info('='.repeat(50));
    logger.info('');
}


function runProcessForWallet(walletIndex) {
    return new Promise((resolve, reject) => {
        const child = fork('./walletProcess.js', [walletIndex.toString()]);

        child.on('message', (message) => {
            console.log(`Process ${walletIndex}: ${message}`);
        });

        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Process ${walletIndex} exited with code ${code}`));
            }
        });
    });
}

async function runOneCycle(totalWallets) {
    const processes = [];

    for (let i = 0; i < totalWallets; i++) {
        processes.push(runProcessForWallet(i));
    }

    try {
        await Promise.all(processes);
        console.log('本轮所有钱包任务都执行成功');
    } catch (error) {
        console.error('本轮任务中有一个或多个钱包进程出错:', error);
    }
}

async function main() {
    printAuthorInfo()
    // 使用索引0来获取总钱包数量
    const { totalWallets } = setupProviderAndWallet(0);
    
    while (true) {
        console.log('开始新一轮任务');
        await runOneCycle(totalWallets);
        console.log('本轮任务结束，休眠24小时');
        await sleep(24 * 60 * 60 * 1000); // 休眠24小时
    }
}

main().catch(console.error);
