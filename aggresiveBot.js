const ethers = require('ethers');
const fs = require('fs');
require("dotenv").config();
const express = require('express');

const app = express();
const port = 5007;

let cachedGasPrice = null;

app.listen(port, async () => {
    console.log(`Server started on port ${port}`);

    async function fetchGasPrice() {
        const feeData = await provider.getFeeData();
        if (feeData && feeData.maxFeePerGas) {
            baseGasPrice = feeData.maxFeePerGas;
            cachedGasPrice = parseInt((parseInt(feeData.maxFeePerGas) * 150) / 100);
        } else {
            console.error('Unable to get fee data or maxFeePerGas.');
        }
    }

    // Fetch gas price once every minute, but not during every event.
    setInterval(fetchGasPrice, 60 * 1000);

    const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
    const provider = new ethers.JsonRpcProvider(`https://rpc.ankr.com/base`);
  
    const BOT_BALANCE_THRESHOLD = BigInt(300000000000000);
    const LEVELS = {
        MIN: BigInt(30000000000000000),
        MID: BigInt(90000000000000000),
        HIGH: BigInt(900000000000000000)
    };
    const PRICES = {
        LOW: BigInt(2000000000000000),
        HIGH: BigInt(10000000000000000)
    };
    
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
    const account = wallet.connect(provider);
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
  
    const balanceSet = new Set();
    const purchasedShares = new Set();
    const buyPricesMap = new Map();
    const finalGasPrice = 5000000000; // Example gas price in Wei

    const handleSell = async (event) => {
        const amigo = event.args[1];
        const bal = await friends.sharesBalance(amigo, wallet.address);

        if (bal > 0 && purchasedShares.has(amigo)) {
            const sellPrice = await friends.getSellPriceAfterFee(amigo, 1);
            const buyPrice = buyPricesMap.get(amigo);

            if (!buyPrice) return;

            // Adjusted the multiplier to 1.6
            if (Number(sellPrice) > (1.60 * Number(buyPrice) + finalGasPrice)) {
                try {
                    const tx = await friends.sellShares(amigo, 1, {
                        gasPrice: parseInt(finalGasPrice),
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
    };
  
    const isBot = (weiBalance) => {
        for (const botBalance of balanceSet) {
            if (
                weiBalance > botBalance - BOT_BALANCE_THRESHOLD &&
                weiBalance < botBalance + BOT_BALANCE_THRESHOLD
            ) {
                return true;
            }
        }
        return weiBalance > 95000000000000000 && weiBalance < 105000000000000000;
    };
  
    const run = async () => {
        let filter = friends.filters.Trade(null, null, null, null, null, null, null, null);
    
        friends.on(filter, async (event) => {
            if (!event.args[2] || event.args[7] > 1n || (event.args[7] <= 4n && event.args[0] !== event.args[1])) return;
    
            const amigo = event.args[1];
            const weiBalance = await provider.getBalance(amigo);
    
            if (isBot(weiBalance)) {
                console.log('Bot detected: ', amigo);
                return;
            }
    
            balanceSet.add(weiBalance); // Change from balanceSet.push to balanceSet.add
            if (balanceSet.size > 20) {
                const balanceArray = Array.from(balanceSet);
                balanceArray.shift();
                balanceSet.clear();
                balanceArray.forEach(item => balanceSet.add(item));
            }
    
            if (weiBalance < LEVELS.MIN) {
                const balance = (Number(weiBalance) * 0.000000000000000001).toFixed(4).toString() + " ETH";
                console.log(`No Money No Honey: ${amigo} ${balance}`);
                return;
            }
    
            let qty = 1;
            if (weiBalance >= LEVELS.MID) qty = 2;
            if (weiBalance >= LEVELS.HIGH) qty = 3;
    
            const buyPrice = await friends.getBuyPriceAfterFee(amigo, qty);
    
            if ((qty < 2 && buyPrice > PRICES.LOW) || buyPrice > PRICES.HIGH) return;
    
            console.log('### BUY ###', amigo, (Number(buyPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH");
            const tx = await friends.buyShares(amigo, qty, { value: buyPrice, gasPrice: cachedGasPrice });
            fs.appendFileSync('./buys.txt', `\n${amigo}, ${buyPrice}`);
    
            buyPricesMap.set(amigo, Number(buyPrice)); // Store buy price
            purchasedShares.add(amigo); // Add address to purchasedShares set
    
            try {
                const receipt = await tx.wait();
                if (receipt.status === 1) {
                    console.log('Transaction Mined:', receipt.blockNumber);
                } else {
                    console.log('Transaction Reverted:', receipt.transactionHash);
                    console.log('Revert Reason:', receipt.revertReason);
                }
            } catch (error) {
                console.log('Transaction Failed:', error);
            }
    
            friends.on('Trade', handleSell); // Register the handleSell function for trade events
        });
    }
  
    try {
        run();
    } catch (error) {
        console.error('ERR:', error);
    }
    
    process.on('uncaughtException', error => {
        console.error('Uncaught Exception:', error);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Promise Rejection:', reason);
    });
});
