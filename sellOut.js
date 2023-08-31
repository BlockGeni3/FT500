const ethers = require('ethers');
const fs = require('fs');
require("dotenv").config();
const express = require('express');
const port = 5006;
const _ = require('lodash');

const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
const provider = new ethers.JsonRpcProvider(`https://rpc.ankr.com/base`);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).connect(provider);
const friends = new ethers.Contract(
    friendsAddress,
    [
        'function sellShares(address sharesSubject, uint256 amount) public payable',
        'function sharesBalance(address sharesSubject, address holder) public view returns (uint256)',
        'function sharesSupply(address sharesSubject) public view returns (uint256)',
        'function getSellPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)'
    ],
    wallet
);
const MIN_PROFIT_MARGIN_PERCENTAGE = 10;

const app = express();

const delay = (duration) => {
    return new Promise(resolve => _.delay(resolve, duration));
};

app.listen(port, () => {
    async function txtToArray(filePath) {
        try {
            const data = await fs.promises.readFile(filePath, 'utf8');
            return data.split('\n').filter(Boolean);
        } catch (error) {
            console.error('Error reading the file:', error);
            throw error;
        }
    }

    let sells = [];

    txtToArray('./buys.txt').then(arr => {
        console.log(arr);
        if(arr.length === 0) { // Check if the array is empty
            console.log('No buy data in buys.txt, shutting down...');
            process.exit(0); // Exit the application
        }
        sells = arr;
        init();
    }).catch(error => {
        console.error('Error:', error);
    });

    let cachedGasPrice = null;
    let lastGasFetch = 0;
    let baseGasPrice = null;
    let finalGasPrice;

    const fetchGasPrice = async () => {
        if (Date.now() - lastGasFetch > 1 * 60 * 1000) { // Fetch every 1 minute
            const feeData = await provider.getFeeData();
            if (feeData && feeData.maxFeePerGas) {
                baseGasPrice = feeData.maxFeePerGas;
                cachedGasPrice = parseInt((parseInt(feeData.maxFeePerGas) * 110) / 100);
                lastGasFetch = Date.now();
            } else {
                console.error('Unable to get fee data or maxFeePerGas.');
            }
        }
    }

    const sellSharesForFriend = async (friend) => {
        const bal = await friends.sharesBalance(friend, wallet.address);
        const supply = await friends.sharesSupply(friend);
        const sellPrice = await friends.getSellPriceAfterFee(friend, bal);

        await fetchGasPrice(); // Fetch the latest gas price
        finalGasPrice = cachedGasPrice;

        // Adjust gas price based on the sell price (Note: We adjust based on the buy price in the provided code. For selling, I'm assuming similar logic with sell price.)
        if (sellPrice < baseGasPrice) {
            finalGasPrice = (cachedGasPrice * 101) / 100;
        } else {
            finalGasPrice = (cachedGasPrice * 150) / 100;
        }

        if (bal > 0 && supply > bal && supply != 0 && friend !== '0x1a310A95F2350d80471d298f54571aD214C2e157') {
            console.log(`Selling ${bal} for: ${friend}`);
            try {
                const tx = await friends.sellShares(friend, bal, { gasPrice: parseInt(finalGasPrice) });
                const receipt = await tx.wait();
                console.log(`Transaction Mined for ${friend}:`, receipt.blockNumber);
            } catch (error) {
                console.error(`Transaction Failed for ${friend}:`, error);
            }
        }
        const newBal = await friends.sharesBalance(friend, wallet.address);
        return newBal;
    }

    const init = async () => {
        let updatedShares = [];  // Initialize the updatedSells array.
        for (const friend of sells) {
            const [friendAddress, friendShareBoughtForPrice] = friend.split(',').map(e => e.trim());
            const sellPrice = await friends.getSellPriceAfterFee(friendAddress, 1);
            const bal = await friends.sharesBalance(friendAddress, wallet.address);
            const nonce = await provider.getTransactionCount(wallet.address, 'pending');
            const realSellPrice = Number(sellPrice);

            if(realSellPrice !== 0) {
                await fetchGasPrice(); 
                finalGasPrice = cachedGasPrice;
                const trueBuyPrice = (parseInt(friendShareBoughtForPrice) + parseInt(finalGasPrice));
                const finalSell = parseInt(realSellPrice);

                await delay(500);  // 0.1-second delay

                if (Number(bal) === 0) {
                    console.log(`You don't own share ${friendAddress}, removing`);
                } else if (finalSell < trueBuyPrice) {
                    const loss = ((trueBuyPrice - parseInt(realSellPrice)) * 0.000000000000000001).toFixed(4).toString() + " ETH";
                    console.log(`Would be selling at a loss for ${loss}, profit margin is below threshold (${MIN_PROFIT_MARGIN_PERCENTAGE}%), skipping`);
                    updatedShares.push(friend); // Keep this address in the buys.txt since it wasn't sold.
                } else { 
                    const newBal = await sellSharesForFriend(friendAddress, {
                        nonce: nonce
                    });
                    const buyP = (Number(friendShareBoughtForPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH";
                    const sellP = (Number(realSellPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH";
                    console.log(`Shares sold for ${sellP}, bought for ${buyP}, your balance is now ${newBal}`);
                    if (Number(newBal) > 0) {
                        updatedShares.pop(friend); // If some balance remains, then push to updatedSells.
                    }
                }
            } else {
                console.log("Skipped selling shares as they can't be sold (0 value).");
                updatedShares.push(friend); // Keep this address in the buys.txt since it wasn't sold.
            }
        } 
        // Update the buys.txt file with the updatedSells array.
        await fs.promises.writeFile('./buys.txt', updatedShares.join('\n'), 'utf8');

        process.exit(0);
    }

    process.on('uncaughtException', error => {
        console.error('Uncaught Exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Promise Rejection:', reason);
    });
});
