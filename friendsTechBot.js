const ethers = require('ethers');
const fs = require('fs');
require("dotenv").config();
const _ = require('lodash');
const retry = require('async-retry');
const express = require('express');

const port = 5005;
const app = express();

app.listen(port, () => {
  console.log(`Server started on port ${port}`);

  const throttledHandleEvent = _.throttle(handleEvent, 5000);

  const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
  const provider = new ethers.JsonRpcProvider(`https://rpc.ankr.com/base`);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  const account = wallet.connect(provider);
  const startBalance = provider.getBalance(wallet.address);
  const friends = new ethers.Contract(
    friendsAddress,
    [
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
  let cachedGasPrice = null;
  let lastGasFetch = 0;
  let baseGasPrice = null;
  const balanceSet = new Set();
  const purchasedShares = new Set();

  async function fetchGasPrice() {
    if (Date.now() - lastGasFetch > 1 * 60 * 1000) { // Fetch every 1 minute instead of 5
      const feeData = await provider.getFeeData();
      if (feeData && feeData.maxFeePerGas) {
        baseGasPrice =  feeData.maxFeePerGas;
        cachedGasPrice = parseInt((parseInt(feeData.maxFeePerGas) * 110) / 100);
        lastGasFetch = Date.now();
      } else {
        console.error('Unable to get fee data or maxFeePerGas.');
      }
    }
  }

  function shouldActOnEvent(event, weiBalance) {
    const amigo = event.args[1];

    if (event.args[2] !== true) return false;
    if (event.args[7] > 1n && (event.args[7] > 4n || event.args[0] !== event.args[1])) return false;
    if (balanceSet.has(weiBalance)) return false; // using a Set instead of an Array
    // if (weiBalance > 95000000000000000 && weiBalance < 105000000000000000) return false;
    if (weiBalance <= 5000000000000000) {
      const ethBalance = (Number(weiBalance) * 0.000000000000000001).toFixed(4).toString() + " ETH";
      console.log(`No Money No Honey: `, amigo, ethBalance);
    }
    // Store the last 20 balances
    balanceSet.add(weiBalance);
    if (balanceSet.size > 20) balanceSet.delete([...balanceSet][0]);

    return true;
  }

  async function handleEvent(event) {
    const amigo = event.args[1];
    const weiBalance = await provider.getBalance(amigo);
    const qty = determineQty(weiBalance);
    const [currentBalance, nonce, sellPrice, buyPrice] = await Promise.all([
      provider.getBalance(wallet.address), 
      provider.getTransactionCount(wallet.address, 'pending'),
      friends.getSellPriceAfterFee(amigo, 1),
      friends.getBuyPriceAfterFee(amigo, qty)
    ]);
    

    if (!shouldActOnEvent(event, weiBalance)) return;

    await fetchGasPrice(); 

    let finalGasPrice = cachedGasPrice;

    // Adjust gas price based on buy price
    if(buyPrice < baseGasPrice) {
      finalGasPrice = (cachedGasPrice * 101) / 100;
    } else {
      finalGasPrice = (cachedGasPrice * 150) / 100; 
    }

    // Skip if cant be sold
    if(Number(sellPrice) === 0) {
      console.log('Skipped buying shares as they cant be sold.');
      return;
    }
    
    // Add this condition to explicitly skip if qty is 0
    if (qty > 0 && buyPrice === 0) {
      console.log('Skipped buying shares as they look botted.');
      return;
    }

    if ((qty < 2 && buyPrice > 2000000000000000) || buyPrice > 10000000000000000) return;

    if(currentBalance < startBalance && Number(currentBalance) <= (Number(startBalance) / 2)) {
      console.log('Balance hit half way point shutting down');
      process.exit();
    }

    if (buyPrice < Number(finalGasPrice)) {
      console.log('Skipped buying shares as they cost less than the gas fee.');
      return;
    }

    if(buyPrice > 0) {
      try {
        const tx = await friends.buyShares(amigo, qty, {value: buyPrice, gasPrice: parseInt(finalGasPrice), nonce: nonce});
        fs.writeFileSync('./buys.txt', `\n${amigo}, ${buyPrice}`, {flag: 'a'});
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
        if (error.message.includes('Too many')) {
          console.error('Rate limit hit. Pausing for a moment...');
          await new Promise(res => setTimeout(res, 10000)); // wait for 10 seconds
        } else {
          let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
          console.log('Transaction Failed:', outMessage);
        }
      }
    }
  }

  async function handleSell(event) {
      const amigo = event.args[1];

      if (!purchasedShares.has(amigo)) return;  // We only care about shares we've previously bought.

      // Here, fetch the current price and compare it to your buy price.
      const sellPrice = await friends.getSellPriceAfterFee(amigo, 1);
      
      const buyPrice = (fs.readFileSync('./buys.txt', 'utf8').split('\n').find(line => line.startsWith(amigo)) || '').split(', ')[1];
      
      if (!buyPrice) return;  // We didn't find the buy price for this share in the buys.txt.

      // Here, you can decide your condition to sell. For simplicity, let's say if the sell price is 10% more than the buy price, we sell.
      if (Number(sellPrice) > 1.10 * Number(buyPrice)) {
          try {
              const tx = await friends.sellShares(amigo, 1); // Assuming you're selling 1 share. Adjust this accordingly.
              console.log(`Sold shares of ${amigo} for a profit!`);
          } catch (error) {
              console.error(`Error selling shares of ${amigo}:`, error.message);
          }
      }
  }

  function determineQty(weiBalance) {
    if (weiBalance < 30000000000000000) return 1;
    if (weiBalance < 90000000000000000) return 2;
    if (weiBalance < 900000000000000000) return 3;
    return 4;
  }

  const run = async () => {
    await retry(async () => {
      // Here we start listening for events. If an error occurs, it'll retry based on the retry configuration.
      friends.on(filter, event => {
        throttledHandleEvent(event);
        handleSell(event);
      });
    }, {
      retries: 5,
      minTimeout: 3000,
      factor: 2
    });
  };

  (async function main() {
    try {
      await run();
    } catch (error) {
      if (error.message.includes('Too many')) {
        console.error('Rate limit hit. Pausing for a moment...');
        await new Promise(res => setTimeout(res, 10000)); // wait for 10 seconds
      } else {
        let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
        console.error('Error encountered:', outMessage);
      }
    }
  })();

  process.on('uncaughtException', error => {
    console.error('Uncaught Exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection:', reason);
  });
});