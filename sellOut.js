const ethers = require('ethers');
const fs = require('fs');
require("dotenv").config();
const express = require('express');
const port = 5006;
const _ = require('lodash');

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

    let cachedGasPrice = null;
    let lastGasFetch = 0;
    let baseGasPrice = null;

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

        let finalGasPrice = cachedGasPrice;

        // Adjust gas price based on the sell price (Note: We adjust based on the buy price in the provided code. For selling, I'm assuming similar logic with sell price.)
        if (sellPrice < baseGasPrice) {
            finalGasPrice = (cachedGasPrice * 101) / 100;
        } else {
            finalGasPrice = (cachedGasPrice * 150) / 100;
        }

        if (bal > 0 && supply > bal && supply != 0 && friend !== '0x1a310A95F2350d80471d298f54571aD214C2e157') {
            console.log(`Selling ${bal} for: ${friend}`);
            try {
                const tx = await friends.sellShares(friend, bal, { gasPrice: finalGasPrice });
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
        let updatedSells = [];
        for (const friend of sells) {
            const [friendAddress, friendShareBoughtForPrice] = friend.split(',').map(e => e.trim());
            const sellPrice = await friends.getSellPriceAfterFee(friendAddress, 1);
            const bal = await friends.sharesBalance(friendAddress, wallet.address);
            const realSellPrice = Number(Number(sellPrice) / 2);

            if(Number(sellPrice) !== 0) {
                if(Number(bal) === 0) {
                    console.log(`You don't own share ${friendAddress}`);
                } else if(realSellPrice < friendShareBoughtForPrice) {
                    console.log(`Would be selling at a loss for ${realSellPrice}, skipping`);
                } else {
                    await delay(2000);  // 2-second delay

                    const newBal = await sellSharesForFriend(friendAddress);
                    console.log(`Shares sold for ${sellPrice}, bought for ${friendShareBoughtForPrice}, your balance is now ${newBal}`);
                    if (Number(newBal) > 0) {
                        updatedSells.push(friend);
                    }
                }
            } else {
                console.log('Skipped selling shares as they cant be sold (0 value).');
            }
        }
        sells = updatedSells;
        fs.promises.writeFile('./buys.txt', '\n'+sells.join('\n'), 'utf8');
        process.exit(0); // Exit the application
    }

    process.on('uncaughtException', error => {
        console.error('Uncaught Exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Promise Rejection:', reason);
    });
});
