const ethers = require('ethers');
const fs = require('fs');
require("dotenv").config();

/**
 * Convert a txt document to an array where each line is an element in the array
 * @param {string} filePath - Path to the .txt file
 * @return {Promise<string[]>} Array of lines from the document
 */
async function txtToArray(filePath) {
    try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        return data.split('\n').filter(Boolean); // Filter out any empty lines
    } catch (error) {
        console.error('Error reading the file:', error);
        throw error;
    }
}

/*
    Trading Bot to sell all known shares
    Provide a list of user addresses in the
    sells array and it will sell out of up to
    3 positions. Does this as individual txs
    because of the way Friend.tech calcs prices
*/
let sells = [];

txtToArray('./buys.txt').then(arr => {
    console.log(arr);
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
        'function getSellPrice(address sharesSubject, uint256 amount) public view returns (uint256)'
    ],
    wallet
);

const sellSharesForFriend = async (friend) => {
    const bal = await friends.sharesBalance(friend, wallet.address);
    const supply = await friends.sharesSupply(friend);
    
    const feeData = await provider.getFeeData();

    if (!feeData || !feeData.maxFeePerGas) {
        console.error('Unable to get fee data or maxFeePerGas.');
        return;
    }

    const gasPrice = parseInt(feeData.maxFeePerGas);
    const finalGasPrice = (gasPrice * 150) / 100; // Increase by 50% to frontrun

    console.log(`Bal for ${friend}:`, bal.toString());
    console.log(`Supply for ${friend}:`, supply.toString());

    for (let i = 1; i <= 3; i++) {
        if (bal >= i && supply > i && friend !== '0x1a310A95F2350d80471d298f54571aD214C2e157') {
            console.log(`Selling ${i} for: ${friend}`);
            try {
                const tx = await friends.sellShares(friend, 1, {finalGasPrice});
                const receipt = await tx.wait();
                console.log(`Transaction ${i} Mined for ${friend}:`, receipt.blockNumber);
            } catch (error) {
                console.log(`Transaction ${i} Failed for ${friend}:`, error);
            }
        }
    }
}

const init = async () => {
    for (const friend of sells) {
        const [friendAddress, friendShareBoughtForPrice] = friend.split(',');
        const bal = await friends.sharesBalance(friendAddress, wallet.address);
        const sellPrice = await friends.getSellPrice(friendAddress, 1);
        
        if(bal > 0) await sellSharesForFriend(friendAddress);
        
    }
}

process.on('uncaughtException', error => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection:', reason);
});
