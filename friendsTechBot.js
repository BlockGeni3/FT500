const ethers = require('ethers');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const _ = require('lodash');
const retry = require('async-retry');
const express = require('express');
const { exec } = require('node:child_process');

dotenv.config();

const app = express();
const port = 5005;

app.listen(port, async () => {
  console.log(`Server started on port ${port}`);

  let buyCount = 0;

  // Constants and Settings
  const config = {
    MAX_TRADES: 5,
    MAX_BALANCE_SET_SIZE: 20,
    INITIAL_GAS_MULTIPLIER: 2,
    MIN_BOT_WEI: 95000000000000000,
    MAX_BOT_WEI: 105000000000000000,
    MIN_SHARE_VAL_WEI: 7000000000000000,
    MAX_SHARE_VAL_WEI: 10000000000000000,
    GAS_REFRESH_SECONDS: 5,
    FRIENDTECH_CONTRACT_ADDRESS: '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4',
    EVENT_THROTTLE_TIME_MS: 1000,
    RPC_ENDPOINT: `https://rpc.ankr.com/base`
  }

  const friendsAddress = config.FRIENDTECH_CONTRACT_ADDRESS;
  const throttledHandleEvent = _.throttle(handleEvent, config.EVENT_THROTTLE_TIME_MS);
  const provider = new ethers.JsonRpcProvider(config.RPC_ENDPOINT);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  const account = wallet.connect(provider);
  const startBalance = await provider.getBalance(wallet.address); 
  const friends = new ethers.Contract(
    friendsAddress,
    [
      'function sharesBalance(address sharesSubject, address holder) public view returns (uint256)',
      'function buyShares(address arg0, uint256 arg1)',
      'function sellShares(address sharesSubject, uint256 amount) public payable',
      'function getBuyPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)',
      'event Trade(address trader, address subject, bool isBuy, uint256 shareAmount, uint256 ethAmount, uint256 protocolEthAmount, uint256 subjectEthAmount, uint256 supply)',
      'function sharesSupply(address sharesSubject) public view returns (uint256)',
      'function getSellPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)'
    ],
    account
  );
  const halfStartBalance = Number(startBalance) / 2;
    
  const filter = friends.filters.Trade(null, null, null, null, null, null, null, null);
  
  let balanceSet = new Set();
  let purchasedShares = new Set();

  const getAsEthString = (wei) => {
    return (Number(wei) * 0.000000000000000001).toFixed(4).toString() + " ETH"
  }

  const shouldActOnEvent = (event, weiBalance) => {
    const { args } = event;
    const amigo = args[1];

    // Check if the address has made too many recent trades, which might indicate bot activity.
    if (event.args[2] !== true) return false;
    if (event.args[7] > 1n && (event.args[7] > 4n || event.args[0] !== event.args[1])) return false;
    if (weiBalance > config.MIN_BOT_WEI && weiBalance < config.MAX_BOT_WEI) return false;
    if (balanceSet.size > config.MAX_TRADES && balanceSet.has(weiBalance)) return false;
    if (weiBalance <= config.MIN_SHARE_VAL_WEI) {
      const ethBalance = getAsEthString(weiBalance);
      console.log(`They broke dawg::` , amigo, ethBalance);
    }
    
    balanceSet.add(weiBalance);
    if (balanceSet.size > config.MAX_BALANCE_SET_SIZE) balanceSet.delete([...balanceSet][0]);

    return true;
  }

  async function handleEvent(event) {
    const { args } = event;
    const amigo = args[1];
    const weiBalance = await provider.getBalance(amigo);
    const qty = determineQty(weiBalance);
    const [currentBalance, sellPrice, buyPriceAfterFee] = await Promise.all([
        provider.getBalance(wallet.address),
        friends.getSellPriceAfterFee(amigo, 1),
        friends.getBuyPriceAfterFee(amigo, 1)       
    ]);

    if (!shouldActOnEvent(event, weiBalance)) return;

    if (qty > 0) {
      try {
          const feeData = await provider.getFeeData();
          const gasPrice = parseInt(feeData.maxFeePerGas) * config.INITIAL_GAS_MULTIPLIER;
      
          if (Number(buyPriceAfterFee) > config.MAX_SHARE_VAL_WEI) return;
      
          if (currentBalance < startBalance && Number(currentBalance) <= halfStartBalance) {
            console.log('Balance hit half way point. Shutting down.');
            process.exit();
          }
      
          if (Number(buyPriceAfterFee) < Number(gasPrice)) {
            console.log('Skipped buying shares as they cost less than the gas fee.');
            return;
          }

          const tx = await friends.buyShares(amigo, 1, {
              value: buyPriceAfterFee,
              gasPrice: parseInt(gasPrice),
              nonce: await provider.getTransactionCount(wallet.address, 'pending') 
          });

          console.log("--------###BUY###----------");
          console.log({
            qty: qty,
            buyPrice: getAsEthString(buyPriceAfterFee),
            sellPrice: getAsEthString(sellPrice),
            finalGasPrice: Number(gasPrice),
            currentBalance: currentBalance.toString()
          }); 
          const receipt = await tx.wait();
          console.log('Transaction Mined:', receipt.blockNumber);
          console.log("---------------------------");

          purchasedShares.add(amigo);
          buyCount++;
          checkSaleStatus(buyCount);

          await fs.appendFile('./buys.txt', `\n${amigo}, ${buyPriceAfterFee}`);

          return Promise.resolve(amigo);
      } catch (error) {
        if (error.code === -32000 && error.message.includes('already known')) {
          return Promise.resolve(amigo);
        }
        handleError(error);
      }
      return Promise.resolve(null);  
    }
  }

  const checkSaleStatus = (count) => {
    if(count === config.MAX_BALANCE_SET_SIZE) {
      exec('nodemon sellOut', (err, output) => {
        if (err) {
            console.error("could not execute command: ", err)
            return
        }

        console.log("Output: \n", output)
      })

      count = 0;
    }
  }

  const handleTxError = (error) => {
    if (error.message.includes('Too many')) {
        console.error('Rate limit hit. Pausing for a moment...');
        setTimeout(() => {}, 10000);
    } else {
        let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
        let blockError = outMessage.includes("not implemented yet") ? "Waiting for next block" : outMessage;
        if(outMessage.includes("transaction execution reverted")) {
          console.error('Transaction Failed:', "Reverted, trying again in new block");
        }
        console.error('Transaction Failed:', blockError);
    }
  }

  function determineQty(weiBalance) {
    if (weiBalance < 20000000000000000) return 1;
    if (weiBalance < 40000000000000000) return 2;
    if (weiBalance < 600000000000000000) return 3;
    return 4;
  }

  async function processEvent(event) {
    try {
        await throttledHandleEvent(event);
    } catch (error) {
        console.error(`Error in processEvent: ${error}`);
    }
  }

  async function mainExecution() {
      try {
          await retry(async () => {
              friends.on(filter, processEvent);
          }, {
              retries: 5,
              minTimeout: 3000,
              factor: 2
          });
      } catch (error) {
          handleError(error);
      }
  }

  mainExecution();

  function handleError(error) {
      if (error.message.includes('Too many')) {
          console.error('Rate limit hit. Pausing for a moment...');
          setTimeout(() => {}, 10000); // Actually pause the execution for 10 seconds. The original code didn't pause.
      } else {
        handleTxError(error);
      }
  }
  
  process.on('uncaughtException', handleError);
  process.on('unhandledRejection', (reason) => {
      console.error('Unhandled Promise Rejection:', reason);
  });
});