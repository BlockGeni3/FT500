const ethers = require('ethers');
const fs = require('fs');
require('dotenv').config();

const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).connect(provider);

const friends = new ethers.Contract(friendsAddress, [
  'function buyShares(address arg0, uint256 arg1)',
  'function getBuyPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)',
  'event Trade(address trader, address subject, bool isBuy, uint256 shareAmount, uint256 ethAmount, uint256 protocolEthAmount, uint256 subjectEthAmount, uint256 supply)',
], wallet);

const gasPrice = ethers.parseUnits('0.000000000000049431', 'ether');

const balanceArray = [];
const BALANCE_ARRAY_LIMIT = 20;
const MIN_BOT_CHECK_VALUE = 300000000000000;
const ETH_0_03 = 30000000000000000;
const ETH_0_1 = 100000000000000000;
const ETH_0_9 = 900000000000000000;
const ETH_0_01 = 10000000000000000;

const priceChanges = [];

const calculateVolatility = () => {
  const mean = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
  const variance = priceChanges.reduce((a, b) => a + (b - mean) ** 2, 0) / priceChanges.length;
  return Math.sqrt(variance);
};

const isPotentialBot = (weiBalance) => {
  if (balanceArray.some((botBalance) => Math.abs(weiBalance - botBalance) <= MIN_BOT_CHECK_VALUE)) {
    console.log('Bot detected:', weiBalance);
    return true;
  }

  if (Math.abs(weiBalance - ETH_0_1) <= MIN_BOT_CHECK_VALUE) {
    return true;
  }

  return false;
};

const run = async () => {
  const filter = friends.filters.Trade();

  friends.on(filter, async (event) => {
    if (!event.args[2] || event.args[7] > 1n || (event.args[7] <= 4n && event.args[0] !== event.args[1])) {
      return;
    }

    const amigo = event.args[1];
    const weiBalance = await provider.getBalance(amigo);

    if (isPotentialBot(weiBalance)) {
      return;
    }

    balanceArray.push(weiBalance);
    if (balanceArray.length > BALANCE_ARRAY_LIMIT) {
      balanceArray.shift();
    }
    if (balanceArray.length < 10) {
      return;
    }

    if (weiBalance < ETH_0_03) {
      console.log(`No Money No Honey: ${amigo} ${weiBalance}`);
      return;
    }

    const priceChange = event.args[4] / event.args[3]; // price per share
    priceChanges.push(priceChange);
    if (priceChanges.length > 100) {
      priceChanges.shift();
    }
    const volatility = calculateVolatility();
    let qty = volatility > 0.05 ? 2 : volatility < 0.01 ? 1 : 1;

    if (weiBalance >= ETH_0_9) {
      qty = 3;
    } else if (weiBalance >= ETH_0_03 * 3) {
      qty = 2;
    }

    const buyPrice = await friends.getBuyPriceAfterFee(amigo, qty);
    if ((qty === 1 && buyPrice > ETH_0_01 / 10) || buyPrice > ETH_0_01) {
      return;
    }

    console.log('### BUY ###', amigo, buyPrice);
    try {
      const tx = await friends.buyShares(amigo, qty, { value: buyPrice, gasPrice });
      fs.appendFileSync('./buys.txt', amigo + '\n');
      const receipt = await tx.wait();
      console.log('Transaction Mined:', receipt.blockNumber);
    } catch (error) {
      console.log('Transaction Failed:', error);
    }
  });
};

run().catch((error) => console.error('ERR:', error));

process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Promise Rejection:', reason));
