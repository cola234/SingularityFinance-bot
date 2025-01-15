const axios = require('axios');
const logger = require('./logger');
const { HttpsProxyAgent } = require('https-proxy-agent');
const ac = require("@antiadmin/anticaptchaofficial");
const dns = require('dns');
require('dotenv').config();

dns.setServers(['8.8.8.8', '8.8.4.4']);

ac.setAPIKey(process.env.ANTICAPTCHA_API_KEY);

async function solveCaptcha() {
    try {
        const token = await ac.solveTurnstileProxyless(
            'https://faucet-testnet.singularityfinance.ai/api/startSession',
            '0x4AAAAAAA2Cr3HyNW-0RONo',
            '',
            ''
        );
        return token;
    } catch (error) {
        console.error('解决验证码失败:', error);
        throw error;
    }
}

async function claimFaucet(address) {
    try {
        const captchaToken = await solveCaptcha();
        if (!captchaToken) {
            console.error(`获取Anti-captcha token失败，地址: ${address}`);
            return false;
        }

        const proxyUrl = process.env.PROXY_URL;
        const proxy = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

        const headers = {
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9',
            'content-type': 'application/json',
            'origin': 'https://faucet-testnet.singularityfinance.ai',
            'referer': 'https://faucet-testnet.singularityfinance.ai/',
            'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        };

        // 第一步：启动会话
        logger.info('Starting session for:', address);
        const sessionResponse = await axios.post(
            'https://faucet-testnet.singularityfinance.ai/api/startSession',
            { addr: address, captchaToken: captchaToken },
            {
                headers: headers,
                httpsAgent: proxy,
                proxy: false
            }
        );

        if (sessionResponse.status !== 200) {
            logger.error(`领水-启动session失败 ${address}. 状态码: ${sessionResponse.status}`);
            return false;
        }

        if (sessionResponse.data.status === 'failed') {
            if (sessionResponse.data.failedCode === 'RECURRING_LIMIT') {
                logger.info(`领水-已经领取过 ${address}. 原因: ${sessionResponse.data.failedReason}`);
                return { status: 'already_claimed', message: sessionResponse.data.failedReason };
            } else {
                logger.error(`领水-启动session失败 ${address}. 原因: ${sessionResponse.data.failedReason}`);
                return { status: 'failed', message: sessionResponse.data.failedReason };
            }
        }
        
        if (!sessionResponse.data.session) {
            logger.error(`领水-启动session失败 ${address}. 未收到有效的session ID`);
            return { status: 'failed', message: '未收到有效的session ID' };
        }

        // 从响应中获取会话ID
        const sessionId = sessionResponse.data.session;

        // 第二步：领取奖励
        const claimResponse = await axios.post(
            'https://faucet-testnet.singularityfinance.ai/api/claimReward',
            {
                session: sessionId,
                captchaToken: await solveCaptcha() // 再次解决验证码
            },
            {
                headers: headers,
                httpsAgent: proxy,
                proxy: false
            }
        );

        if (claimResponse.status !== 200) {
            logger.error(`领水-领取奖励失败 ${address}. 状态码: ${claimResponse.status}`);
            return false;
        }
        if (claimResponse.data.status === 'claiming' && claimResponse.data.session) {
            logger.info(`领水-领取奖励成功 ${address}:`, claimResponse.data);
            return { status: 'success', data: claimResponse.data };
        } else {
            logger.error(`领水-领取奖励失败 ${address}. 服务器返回:`, claimResponse.data);
            return { status: 'failed', message: '领取奖励失败' };
        }
    } catch (error) {
        logger.error(`Error claiming faucet for ${address}:`, error.message);
        if (error.response) {
            logger.error('Response status:', error.response.status);
            logger.error('Response data:', error.response.data);
        } else if (error.request) {
            logger.error('No response received:', error.request);
        }
        throw error; // 抛出错误以便重试机制捕获
    }
}

async function claimFaucetWithRetry(address, maxRetries = 3, delay = 5000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await claimFaucet(address);
            
            // 如果是已经领取过的情况，直接返回，不重试
            if (result.status === 'already_claimed') {
                return result;
            }
            
            // 如果成功，直接返回
            if (result.status === 'success') {
                return result;
            }
            
            // 如果是其他类型的失败，继续重试
            logger.error(`领水尝试 ${attempt} 失败，等待 ${delay/1000} 秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (error) {
            if (attempt === maxRetries) {
                logger.error(`最后一次尝试失败，地址: ${address}`, error);
                return { status: 'failed', message: '多次尝试后仍然失败' };
            }
            logger.error(`领水尝试 ${attempt} 出错，等待 ${delay/1000} 秒后重试...`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return { status: 'failed', message: '达到最大重试次数' };
}

module.exports = { claimFaucetWithRetry };
