const ethers = require('ethers');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// 读取 WrappedSFI ABI
const wrappedSFIABI = JSON.parse(fs.readFileSync(path.join(__dirname, 'ABI', 'WrappedSFI.json'), 'utf8'));

// 设置合约地址
const STAKING_CONTRACT_ADDRESS = '0x22Dbdc9e8dd7C5E409B014BBcb53a3ef39736515';
const WRAPPED_SFI_ADDRESS = '0x6dC404EFd04B880B0Ab5a26eF461b63A12E3888D';

// 部分 ABI 定义
const partialStakingABI = [
    {
        "inputs": [],
        "name": "claim",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "_amount",
                "type": "uint256"
            }
        ],
        "name": "withdrawAndClaim",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "_amount",
                "type": "uint256"
            },
            {
                "internalType": "uint256",
                "name": "_lockingPeriod",
                "type": "uint256"
            }
        ],
        "name": "deposit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "account",
                "type": "address"
            }
        ],
        "name": "userInfo",
        "outputs": [
            {
                "components": [
                    {
                        "internalType": "uint256",
                        "name": "amount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "lockDate",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "unlockDate",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "score",
                        "type": "uint256"
                    }
                ],
                "internalType": "struct SDAOLockedStaking.UserInfo",
                "name": "",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];
// 重试函数
async function retry(operation, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) {
                logger.error(`所有重试失败，最后一次错误: ${error.message}`);
                throw error;
            }
            logger.warn(`尝试 ${attempt} 失败，5秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// 计算最优锁定期
function calculateOptimalLockingPeriod(unlockDate) {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const MAX_LOCKING_PERIOD = 360 * 24 * 60 * 60; // 360 天in秒

    if (unlockDate <= currentTimestamp) {
        // 如果已经解锁，使用最大锁定期
        return MAX_LOCKING_PERIOD;
    } else {
        // 计算剩余的锁定时间
        const remainingLockTime = unlockDate - currentTimestamp;
        // 返回剩余锁定时间，但不超过最大锁定期
        return Math.min(remainingLockTime, MAX_LOCKING_PERIOD);
    }
}

async function stakeTokens(wallet, amount) {
    return retry(async () => {
        const stakingContract = new ethers.Contract(STAKING_CONTRACT_ADDRESS, partialStakingABI, wallet);
        const wrappedSFIContract = new ethers.Contract(WRAPPED_SFI_ADDRESS, wrappedSFIABI, wallet);
        const amountInWei = ethers.utils.parseEther(amount.toString());

        try {
            let optimalLockingPeriod;
            const userInfo = await stakingContract.userInfo(wallet.address);
            logger.info('当前用户质押信息:');
            logger.info(`- 质押数量: ${ethers.utils.formatEther(userInfo.amount)} WSFI`);
            logger.info(`- 质押分数: ${userInfo.score.toString()}`);

            const hasExistingStake = userInfo.amount.gt(ethers.constants.Zero);

            if(hasExistingStake){
                logger.info('存在质押')
                optimalLockingPeriod = calculateOptimalLockingPeriod(userInfo.unlockDate.toNumber());
                logger.info(`计算的最优锁定期（秒）: ${optimalLockingPeriod}`);
            } else {
                logger.info('不存在质押')
                optimalLockingPeriod = 7776000
            }

            const wSFIBalance = await wrappedSFIContract.balanceOf(wallet.address);
            logger.info(`wSFI 余额: ${ethers.utils.formatEther(wSFIBalance)} wSFI`);

            if (wSFIBalance.lt(amountInWei)) {
                throw new Error('wSFI 余额不足');
            }

            logger.info('批准 staking 合约使用代币...');
            const approveTx = await wrappedSFIContract.approve(STAKING_CONTRACT_ADDRESS, amountInWei);
            await approveTx.wait();
            logger.info('批准成功');

            logger.info('调用 staking 合约进行质押...');
            const depositTx = await stakingContract.deposit(amountInWei, optimalLockingPeriod, {
                gasLimit: 300000,
            });
            
            logger.info('等待交易确认...');
            const receipt = await depositTx.wait();
            
            if (receipt.status === 0) {
                throw new Error('交易执行失败');
            }
            
            logger.info('质押成功！');

            logger.info('等待10秒以确保质押更新...');
            await new Promise(resolve => setTimeout(resolve, 10000));

            const updatedUserInfo = await stakingContract.userInfo(wallet.address);
            logger.info('更新后用户质押信息:');
            logger.info(`- 质押数量: ${ethers.utils.formatEther(updatedUserInfo.amount)} SFI`);
            logger.info(`- 质押分数: ${updatedUserInfo.score.toString()}`);

            return receipt.transactionHash;
        } catch (error) {
            logger.error('质押操作失败:', error);
            if (error.error && error.error.message) {
                logger.error('错误详情:', error.error.message);
            }
            throw error;
        }
    });
}

async function getStakedAmount(wallet) {
    return retry(async () => {
        try {
            const stakingContract = new ethers.Contract(STAKING_CONTRACT_ADDRESS, partialStakingABI, wallet.provider);
            const userInfo = await stakingContract.userInfo(wallet.address);
            
            const stakedAmount = ethers.utils.formatEther(userInfo.amount);
            
            logger.info(`用户 ${wallet.address} 的质押数量: ${stakedAmount} WSFI`);
            
            return stakedAmount;
        } catch (error) {
            logger.error("获取质押数量时发生错误:", error);
            throw error;
        }
    });
}
async function withdrawAndClaim(wallet, amount) {
    return retry(async () => {
        const stakingContract = new ethers.Contract(STAKING_CONTRACT_ADDRESS, partialStakingABI, wallet);
        const amountInWei = ethers.utils.parseEther(amount.toString());

        try {
            const userInfoBefore = await stakingContract.userInfo(wallet.address);
            logger.info('提取前用户质押信息:');
            logger.info(`- 质押数量: ${ethers.utils.formatEther(userInfoBefore.amount)} SFI`);
            logger.info(`- 质押分数: ${userInfoBefore.score.toString()}`);

            if (userInfoBefore.amount.lt(amountInWei)) {
                throw new Error('质押金额不足，无法提取指定数量');
            }

            logger.info('请求提取数量:', amount, 'wSFI');

            logger.info('调用 staking 合约进行提取和领取奖励...');
            const withdrawTx = await stakingContract.withdrawAndClaim(amountInWei, {
                gasLimit: 300000,
            });
            
            logger.info('等待交易确认...');
            const receipt = await withdrawTx.wait();
            
            if (receipt.status === 0) {
                logger.error(`交易失败。交易哈希: ${receipt.transactionHash}`);
                throw new Error('交易执行失败');
            }
            
            logger.info('提取和领取奖励成功！');

            logger.info('等待10秒以确保更新...');
            await new Promise(resolve => setTimeout(resolve, 10000));

            const userInfoAfter = await stakingContract.userInfo(wallet.address);
            logger.info('提取后用户质押信息:');
            logger.info(`- 质押数量: ${ethers.utils.formatEther(userInfoAfter.amount)} WSFI`);
            logger.info(`- 质押分数: ${userInfoAfter.score.toString()}`);
            const actualWithdrawn = userInfoBefore.amount.sub(userInfoAfter.amount);
            logger.info(`实际提取数量: ${ethers.utils.formatEther(actualWithdrawn)} WSFI`);

            return receipt.transactionHash;
        } catch (error) {
            logger.error('提取和领取奖励操作失败:', error);
            if (error.error && error.error.message) {
                logger.error('错误详情:', error.error.message);
            }
            throw error;
        }
    });
}

async function claim(wallet) {
    return retry(async () => {
        const stakingContract = new ethers.Contract(STAKING_CONTRACT_ADDRESS, partialStakingABI, wallet);

        try {
            logger.info('调用 staking 合约进行奖励领取...');
            const claimTx = await stakingContract.claim({
                gasLimit: 200000,
            });
            
            logger.info('等待交易确认...');
            const receipt = await claimTx.wait();
            
            if (receipt.status === 0) {
                logger.error(`交易失败。交易哈希: ${receipt.transactionHash}`);
                logger.error('使用的 gas:', receipt.gasUsed.toString());
                throw new Error('交易执行失败');
            }
            
            logger.info('奖励领取成功！');

            const rewardEvent = receipt.logs.find(log => log.address === "0x22Dbdc9e8dd7C5E409B014BBcb53a3ef39736515");
            if (rewardEvent) {
                const rewardAmount = ethers.utils.formatEther(rewardEvent.data);
                logger.info('领取的奖励数量:', rewardAmount, 'wSFI');
            } else {
                logger.error('无法从交易日志中获取奖励数量。');
            }

            logger.info(`交易哈希: ${receipt.transactionHash}`);

            return receipt.transactionHash;
        } catch (error) {
            logger.error('奖励领取操作失败:', error);
            if (error.error && error.error.message) {
                logger.error('错误详情:', error.error.message);
            }
            throw error;
        }
    });
}

module.exports = { stakeTokens, withdrawAndClaim, claim, getStakedAmount };