const ethers = require('ethers');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const _ = require('lodash');
const retry = require('async-retry');
const express = require('express');

dotenv.config();

const app = express();
const port = 5005;

let buyPricesMap = new Map();  // Use a Map to keep track of buy prices for quicker lookup

app.listen(port, async () => {
  console.log(`Server started on port ${port}`);

  let cachedGasPrice = null;
  let baseGasPrice = null;
  let finalGasPrice;

  const MAX_TRADES = 5;
  const MAX_BALANCE_SET_SIZE = 20;
  const MAX_GAS_PRICE_MULTIPLIER = 1.4;
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
  const filter = friends.filters.Trade(null, null, null, null, null, null, null, null);
  const balanceSet = new Set();
  const purchasedShares = new Set();
  const blacklistedAddresses = new Set();
  const halfStartBalance = Number(startBalance) / 2;

  let currentNonce = await provider.getTransactionCount(wallet.address);

  async function fetchGasPrice() {
    const feeData = await provider.getFeeData();
    if (feeData && feeData.maxFeePerGas) {
        baseGasPrice = feeData.maxFeePerGas;
        cachedGasPrice = parseInt((parseInt(feeData.maxFeePerGas) * 200) / 100);
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
    const [currentBalance, nonce, sellPrice, buyPrice] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getTransactionCount(wallet.address, 'pending'),
        friends.getSellPriceAfterFee(amigo, 1),
        friends.getBuyPriceAfterFee(amigo, qty)
    ]);

    if (!shouldActOnEvent(event, weiBalance)) return;

    finalGasPrice = cachedGasPrice;

    const gasMultiplier = buyPrice < baseGasPrice ? MIN_GAS_PRICE_MULTIPLIER : MAX_GAS_PRICE_MULTIPLIER;
    finalGasPrice = parseInt(cachedGasPrice * gasMultiplier);

    if ((qty < 2 && buyPrice > 1000000000000000) || buyPrice > 5000000000000000) return;

    if (currentBalance < startBalance && Number(currentBalance) <= halfStartBalance) {
      console.log('Balance hit half way point. Shutting down.');
      process.exit();
    }

    if (buyPrice < Number(finalGasPrice)) {
      console.log('Skipped buying shares as they cost less than the gas fee.');
      return;
    }

    if (qty > 0) {
      try {
          const tx = await friends.buyShares(amigo, qty, {
            value: buyPrice,
            gasPrice: parseInt(finalGasPrice),
            nonce: currentNonce
          });
          await fs.appendFile('./buys.txt', `\n${amigo}, ${buyPrice}`);
          buyPricesMap.set(amigo, buyPrice);  
          console.log("--------###BUY###----------");
          console.log({
            qty: qty,
            buyPrice: (Number(buyPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH",
            sellPrice: (Number(sellPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH",
            finalGasPrice: finalGasPrice,
            currentBalance: currentBalance.toString(),
            nonce: nonce
          });
          const receipt = await tx.wait();
          console.log('Transaction Mined:', receipt.blockNumber);
          console.log("---------------------------");
          purchasedShares.add(amigo);
      } catch (error) {
          handleTxError(error);
      }
    }
  }

  function handleTxError(error) {
    if (error.message.includes('Too many')) {
        console.error('Rate limit hit. Pausing for a moment...');
        setTimeout(() => {}, 10000);  // wait for 10 seconds
    } else {
        let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
        console.error('Transaction Failed:', outMessage);
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

  async function handleSell(event) {
    const amigo = event.args[1];
    const bal = await friends.sharesBalance(amigo, wallet.address);

    if (bal > 0 && purchasedShares.has(amigo)) {
        const sellPrice = await friends.getSellPriceAfterFee(amigo, 1);
        const buyPrice = buyPricesMap.get(amigo);

        if (!buyPrice) return;

        // Adjusted the multiplier to 1.6
        if (Number(sellPrice) > (1.60 * Number(buyPrice) + finalGasPrice)) {
            const currentBalance = await provider.getBalance(wallet.address);
            
            // Adjust gas price for selling based on sell price
            let adjustedGasPrice = cachedGasPrice;
            if (sellPrice < baseGasPrice) {
                adjustedGasPrice = (cachedGasPrice * 110) / 100; // 110% of the cached price
            } else {
                adjustedGasPrice = (cachedGasPrice * 140) / 100; // 140% of the cached price
            }

            try {
                const tx = await friends.sellShares(amigo, 1, {
                    gasPrice: parseInt(adjustedGasPrice),
                    nonce: await provider.getTransactionCount(wallet.address, 'pending')
                });

                purchasedShares.delete(amigo); // Remove address from set after selling

                console.log(`Sold shares of ${amigo} for a profit!`);
            } catch (error) {
                console.error(`Error selling shares of ${amigo}:`, error.message);
            }
        }
    } else {
        purchasedShares.delete(amigo);
    }
  }

  function determineQty(weiBalance) {
    if (weiBalance < 40000000000000000) return 1;
    if (weiBalance < 80000000000000000) return 2;
    if (weiBalance < 900000000000000000) return 3;
    return 4;
  }

  async function processEvent(event) {
    await throttledHandleEvent(event);
    await handleSell(event);
  }

  const run = async () => {
      await retry(async () => {
          friends.on(filter, processEvent);
      }, {
          retries: 5,
          minTimeout: 3000,
          factor: 1
      });
  };

  // Main function execution
  (async function main() {
      try {
          await run();
      } catch (error) {
          handleError(error);
      }
  })();

  function handleError(error) {
      if (error.message.includes('Too many')) {
          console.error('Rate limit hit. Pausing for a moment...');
          setTimeout(() => {}, 10000);
      } else {
          let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
          console.error('Error encountered:', outMessage);
      }
  }

  process.on('uncaughtException', handleError);
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Promise Rejection:', reason);
  });
});