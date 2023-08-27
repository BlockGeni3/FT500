const ethers = require('ethers');
const fs = require('fs');
require("dotenv").config();

const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
const provider = new ethers.JsonRpcProvider(`https://rpc.ankr.com/base`);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
const account = wallet.connect(provider);
const friends = new ethers.Contract(
  friendsAddress,
  [
    'function buyShares(address arg0, uint256 arg1)',
    'function getBuyPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)',
    'event Trade(address trader, address subject, bool isBuy, uint256 shareAmount, uint256 ethAmount, uint256 protocolEthAmount, uint256 subjectEthAmount, uint256 supply)',
    'function sharesSupply(address sharesSubject) public view returns (uint256)'
  ],
  account
);

const filter = friends.filters.Trade(null, null, null, null, null, null, null, null);
let cachedGasPrice = null;
let lastGasFetch = 0;
const balanceSet = new Set();

async function fetchGasPrice() {
  if (Date.now() - lastGasFetch > 5 * 60 * 1000) { // Fetch every 5 minutes
    const feeData = await provider.getFeeData();
    if (feeData && feeData.maxFeePerGas) {
      cachedGasPrice = (parseInt(feeData.maxFeePerGas) * 200) / 100;
      lastGasFetch = Date.now();
    } else {
      console.error('Unable to get fee data or maxFeePerGas.');
    }
  }
}

function shouldActOnEvent(event, weiBalance) {
  if (event.args[2] !== true) return false;
  if (event.args[7] > 1n && (event.args[7] > 4n || event.args[0] !== event.args[1])) return false;
  if (balanceSet.has(weiBalance)) return false; // using a Set instead of an Array
  if (weiBalance > 95000000000000000 && weiBalance < 105000000000000000) return false;

  // Store the last 20 balances
  balanceSet.add(weiBalance);
  if (balanceSet.size > 20) balanceSet.delete([...balanceSet][0]);

  return true;
}

async function handleEvent(event) {
  await fetchGasPrice();
  const finalGasPrice = (cachedGasPrice * 125) / 100; // Increase by 50% to frontrun
  const amigo = event.args[1];
  const weiBalance = await provider.getBalance(amigo);

  if (!shouldActOnEvent(event, weiBalance)) return;

  const qty = determineQty(weiBalance);
  const buyPrice = await friends.getBuyPriceAfterFee(amigo, qty);
  const supply = await friends.sharesSupply(amigo);

  if ((qty < 2 && buyPrice > 2000000000000000) || buyPrice > 10000000000000000) return;

  if(buyPrice > 0) {
    try {
      const nonce = await provider.getTransactionCount(wallet.address, 'pending');
      const tx = await friends.buyShares(amigo, qty, {value: buyPrice, gasPrice: finalGasPrice, nonce: nonce});
      fs.writeFileSync('./buys.txt', `${amigo}, ${buyPrice}\n`, {flag: 'a'});
      const receipt = await tx.wait();
      console.log('Transaction Mined:', receipt.blockNumber);
    } catch (error) {
      console.error('Transaction Failed:', error);
    }
  } else {
    console.log(supply, buyPrice);
  }
}

function determineQty(weiBalance) {
  if (weiBalance < 30000000000000000) return 0;
  if (weiBalance < 90000000000000000) return 1;
  if (weiBalance < 900000000000000000) return 2;
  return 3;
}

const run = () => {
  friends.on(filter, handleEvent);
};

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
