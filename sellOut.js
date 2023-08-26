const ethers = require('ethers');
require("dotenv").config();

/*
    Trading Bot to sell all known shares
    Provide a list of user addresses in the
    sells array and it will sell out of up to
    3 positions. Does this as individual txs
    because of the way Friend.tech calcs prices
*/

const sells = [];

const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
const provider = new ethers.JsonRpcProvider(`https://mainnet.base.org`);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).connect(provider);
const gasPrice = ethers.parseUnits('0.000000000000049431', 'ether');
const friends = new ethers.Contract(
    friendsAddress,
    [
        'function sellShares(address sharesSubject, uint256 amount) public payable',
        'function sharesBalance(address sharesSubject, address holder) public view returns (uint256)',
        'function sharesSupply(address sharesSubject) public view returns (uint256)',
    ],
    wallet
);

const sellSharesForFriend = async (friend) => {
    const bal = await friends.sharesBalance(friend, wallet.address);
    const supply = await friends.sharesSupply(friend);

    for (let i = 1; i <= 3; i++) {
        if (bal >= i && supply > i && friend !== '0x1a310A95F2350d80471d298f54571aD214C2e157') {
            console.log(`Selling ${i} for: ${friend}`);
            try {
                const tx = await friends.sellShares(friend, 1, {gasPrice});
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
        await sellSharesForFriend(friend);
    }
}

init();

process.on('uncaughtException', error => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection:', reason);
});
