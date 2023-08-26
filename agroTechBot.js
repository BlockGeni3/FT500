const ethers = require('ethers');
require("dotenv").config();

const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
const provider = new ethers.JsonRpcProvider(`https://mainnet.base.org`);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).connect(provider);
const gasPrice = ethers.parseUnits('0.000000000000049431', 'ether');

const createRandomWallet = async () => {
    const tempWallet = ethers.Wallet.createRandom();
    console.log('Public Key:', tempWallet.address);
    console.log('Private Key:', tempWallet.privateKey);
    return tempWallet;
}

const transferFunds = async (fromWallet, toAddress, value) => {
    const tx = await fromWallet.sendTransaction({
        to: toAddress,
        value: value,
        gasPrice
    });
    return tx.wait();
}

const buyAndSellShares = async (wallet, sharesAddress) => {
    const contract = new ethers.Contract(
      friendsAddress,
      [
        'function buyShares(address arg0, uint256 arg1)',
        'function getBuyPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)',
        'function sharesBalance(address sharesSubject, address holder) public view returns (uint256)',
        'function sharesSupply(address sharesSubject) public view returns (uint256)',
        'function sellShares(address sharesSubject, uint256 amount) public payable',
        'event Trade(address trader, address subject, bool isBuy, uint256 shareAmount, uint256 ethAmount, uint256 protocolEthAmount, uint256 subjectEthAmount, uint256 supply)',
      ],
      wallet
    );

    for (let i = 0; i < 3; i++) {
        const buyPrice = await contract.getBuyPriceAfterFee(sharesAddress, 1);
        await contract.buyShares(sharesAddress, 1, {value: buyPrice, gasPrice});
    }

    for (let i = 0; i < 3; i++) {
        await contract.sellShares(sharesAddress, 1, {gasPrice});
    }
}

const run = async () => {
    const preTmpWallet = createRandomWallet();
    await new Promise(r => setTimeout(r, 10000));

    await transferFunds(wallet, preTmpWallet.address, ethers.parseEther('0.00116'));

    const tmpWallet = createRandomWallet();

    const preBalance = await provider.getBalance(preTmpWallet.address);
    await transferFunds(preTmpWallet, tmpWallet.address, preBalance.sub(ethers.BigNumber.from('20000000000000')));

    await buyAndSellShares(tmpWallet.connect(provider), tmpWallet.address);

    const weiBalance = await provider.getBalance(tmpWallet.address);
    await transferFunds(tmpWallet, wallet.address, weiBalance.sub(ethers.BigNumber.from('20000000000000')));

    run();
}

try {
    run();
} catch (error) {
    console.error('ERR:', error);
}

process.on('uncaughtException', error => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Promise Rejection:', reason);
    try {  
        const account = tmpWallet.connect(provider);
        const weiBalance = await provider.getBalance(tmpWallet.address);
        await transferFunds(account, wallet.address, weiBalance.sub(ethers.BigNumber.from('20000000000000')));
    } catch (err) {
        console.log('Cant transfer out');
    }
    run();
});