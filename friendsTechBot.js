const ethers = require('ethers');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const _ = require('lodash');
const retry = require('async-retry');
const express = require('express');
const { exec } = require('node:child_process')


dotenv.config();

const app = express();
const port = 5005;
let buyPricesMap = new Map();  // Use a Map for faster lookup of buy prices

app.listen(port, async () => {
  console.log(`Server started on port ${port}`);

  let cachedGasPrice = null;
  let baseGasPrice = null;
  let finalGasPrice;
  let buyCount = 0;

  // Constants and Settings
  const MAX_TRADES = 5;
  const MAX_BALANCE_SET_SIZE = 20;
  const MAX_GAS_PRICE_MULTIPLIER = 1.6;
  const MIN_GAS_PRICE_MULTIPLIER = 1.1;
  const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
  const throttledHandleEvent = _.throttle(handleEvent, 1000);
  const provider = new ethers.JsonRpcProvider(`https://rpc.ankr.com/base`);
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
  let blacklistedAddresses = new Set();

  async function fetchGasPrice() {
    const feeData = await provider.getFeeData();
    if (feeData && feeData.maxFeePerGas) {
        baseGasPrice = feeData.maxFeePerGas;
        cachedGasPrice = parseInt((parseInt(feeData.maxFeePerGas) * 210) / 100);
    } else {
        console.error('Unable to get fee data or maxFeePerGas.');
    }
  }

  // Fetch gas price once every minute, but not during every event.
  setInterval(fetchGasPrice, 5 * 1000);

  function shouldActOnEvent(event, weiBalance) {
    const { args } = event;
    const amigo = args[1];

    // Check if the address has made too many recent trades, which might indicate bot activity.
    if (event.args[2] !== true) return false;
    if (event.args[7] > 1n && (event.args[7] > 4n || event.args[0] !== event.args[1])) return false;
    if (weiBalance > 95000000000000000 && weiBalance < 105000000000000000) return false;
    if (balanceSet.size > MAX_TRADES && balanceSet.has(weiBalance)) return false;
    if (weiBalance <= 5000000000000000) {
      const ethBalance = (Number(weiBalance) * 0.000000000000000001).toFixed(4).toString() + " ETH";
      console.log(`They broke dawg::` , amigo, ethBalance);
    }
    if (blacklistedAddresses.has(amigo)) {
      console.log('Skipped buying shares from known bot:', amigo);
      return false;
    }
    // Store the last 20 balances
    balanceSet.add(weiBalance);
    if (balanceSet.size > MAX_BALANCE_SET_SIZE) balanceSet.delete([...balanceSet][0]);

    return true;
  }

  async function handleEvent(event) {
    const { args } = event;
    const amigo = args[1];
    const weiBalance = await provider.getBalance(amigo);
    const qty = determineQty(weiBalance);
    const [currentBalance, sellPrice] = await Promise.all([
        provider.getBalance(wallet.address),
        friends.getSellPriceAfterFee(amigo, 1)       
    ]);

    if (!shouldActOnEvent(event, weiBalance)) return;

    finalGasPrice = cachedGasPrice;
    if (qty > 0) {
      try {
          const buyPrice = await friends.getBuyPriceAfterFee(amigo, 1)
          const gasMultiplier = buyPrice < baseGasPrice ? MIN_GAS_PRICE_MULTIPLIER : MAX_GAS_PRICE_MULTIPLIER;
          finalGasPrice = parseInt(cachedGasPrice * gasMultiplier);
      
          if (Number(buyPrice) > 1000000000000000) return;
      
          if (currentBalance < startBalance && Number(currentBalance) <= halfStartBalance) {
            console.log('Balance hit half way point. Shutting down.');
            process.exit();
          }
      
          if (Number(buyPrice) < Number(finalGasPrice)) {
            console.log('Skipped buying shares as they cost less than the gas fee.');
            return;
          }

          const tx = await friends.buyShares(amigo, 1, {
              value: await friends.getBuyPriceAfterFee(amigo, 1),
              gasPrice: parseInt(finalGasPrice),
              nonce: await provider.getTransactionCount(wallet.address, 'pending') 
          });
          console.log("--------###BUY###----------");
          console.log({
            qty: qty,
            buyPrice: (Number(buyPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH",
            sellPrice: (Number(sellPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH",
            finalGasPrice: Number(finalGasPrice),
            currentBalance: currentBalance.toString()
          }); 
          const receipt = await tx.wait();
          console.log('Transaction Mined:', receipt.blockNumber);
          console.log("---------------------------");
          purchasedShares.add(amigo);
          buyCount++;
          checkSaleStatus(buyCount);
          await fs.appendFile('./buys.txt', `\n${amigo}, ${buyPrice}`);
          buyPricesMap.set(amigo, buyPrice);  
          return Promise.resolve(amigo);
      } catch (error) {
        if (error.code === -32000 && error.message.includes('already known')) {
          return Promise.resolve(amigo);
        }
        handleTxError(error);
      }
      return Promise.resolve(null);  
    }
  }

  function checkSaleStatus(count) {
    if(count === 20) {
      // run sell script
      exec('nodemon sellOut', (err, output) => {
        // once the command has completed, the callback function is called
        if (err) {
            // log and return if we encounter an error
            console.error("could not execute command: ", err)
            return
        }
        // log the output received from the command
        console.log("Output: \n", output)
      })

      count = 0;
    }
  }

  function handleTxError(error) {
    if (error.message.includes('Too many')) {
        console.error('Rate limit hit. Pausing for a moment...');
        setTimeout(() => {}, 10000);
    } else {
        let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
        let blockError = outMessage.includes("not implemented yet") ? "Waiting for next block" : outMessage;if(outMessage.includes("transaction execution reverted")) {
          console.error('Transaction Failed:', "Reverted, trying again in new block");
        }
        console.error('Transaction Failed:', blockError);
    }
  }

  const initBuyPrices = async () => {
    try {
      const data = await fs.readFile('./buys.txt', 'utf8');
      data.split('\n').map(line => {
        const [address, price] = line.split(', ');
        buyPricesMap.set(address, price);
      });
    } catch (e) {
      console.error('Error reading buys.txt:', e);
    }
  };

  await initBuyPrices();

  function determineQty(weiBalance) {
    if (weiBalance < 40000000000000000) return 1;
    if (weiBalance < 80000000000000000) return 2;
    if (weiBalance < 900000000000000000) return 3;
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
              factor: 1
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
        let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
        let blockError = outMessage.includes("not implemented yet") ? "Waiting for next block" : outMessage;
        if(outMessage.includes('execution reverted: "Insufficient payment"')) {
          const gasMultiplier = baseGasPrice ? MIN_GAS_PRICE_MULTIPLIER : MAX_GAS_PRICE_MULTIPLIER;
          cachedGasPrice = parseInt(cachedGasPrice * gasMultiplier);
        } else if(outMessage.includes("transaction execution reverted")) {
          console.error('Transaction Failed:', "Reverted, trying again in new block");
        }
        console.error('Transaction Failed:', blockError);
      }
  }

  // Error listeners
  process.on('uncaughtException', handleError);
  process.on('unhandledRejection', (reason) => {
      console.error('Unhandled Promise Rejection:', reason);
  });
});