require('dotenv').config();
const { fork } = require('child_process');
const setupProviderAndWallet = require('./walletSetup');
const logger = require('./src/logger');

// 从环境变量获取配置，如果没有设置则使用默认值
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_WALLETS) || 3;
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY_MS) || 5000;
const WALLET_DELAY = parseInt(process.env.WALLET_DELAY_MS) || 5000;

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
            logger.info(`Process ${walletIndex}: ${message}`);
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
    logger.info(`使用配置: 最大并发数=${MAX_CONCURRENT}, 批次延迟=${BATCH_DELAY}ms, 钱包延迟=${WALLET_DELAY}ms`);
    
    // 按批次处理钱包
    for (let i = 0; i < totalWallets; i += MAX_CONCURRENT) {
        const processes = [];
        const batchSize = Math.min(MAX_CONCURRENT, totalWallets - i);
        
        // 启动这一批的钱包进程
        for (let j = 0; j < batchSize; j++) {
            const walletIndex = i + j;
            processes.push(runProcessForWallet(walletIndex));
            
            // 每个钱包启动之间添加短暂延迟
            if (j < batchSize - 1) {
                await sleep(WALLET_DELAY);
            }
        }

        try {
            // 等待这一批钱包处理完成
            await Promise.all(processes);
            logger.info(`完成第 ${i/MAX_CONCURRENT + 1} 批钱包处理`);
        } catch (error) {
            logger.error(`第 ${i/MAX_CONCURRENT + 1} 批处理中有钱包出错:`, error);
        }
        
        // 批次之间添加延迟
        if (i + MAX_CONCURRENT < totalWallets) {
            await sleep(BATCH_DELAY);
        }
    }
    
    logger.info('本轮所有钱包任务都执行完成');
}

async function main() {
    printAuthorInfo();
    const { totalWallets } = setupProviderAndWallet(0);
    
    while (true) {
        logger.info('开始新一轮任务');
        await runOneCycle(totalWallets);
        logger.info('本轮任务结束，休眠24小时');
        await sleep(24 * 60 * 60 * 1000); // 休眠24小时
    }
}

main().catch(error => {
    logger.error('程序运行出错:', error);
    process.exit(1);
});
