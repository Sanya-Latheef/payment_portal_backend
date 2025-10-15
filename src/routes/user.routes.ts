import { Router } from 'express';
import { 
    getUserProfileAndBalance, 
    getUserTransactions, 
    addFunds, 
    sendMoney, 
    payBill, 
    registerUser, 
    loginUser,
    getUserBankAccounts, // NEW
    addBankAccount,      // NEW
    getUpiIds,
    addUpiId,
    getCards,
    addCard

} from '../controllers/user.controller';

const router = Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/user/profile', getUserProfileAndBalance);
router.post('/user/transactions', getUserTransactions);
router.post('/user/funds/add', addFunds);
router.post('/user/transfer/p2p', sendMoney);
router.post('/user/pay/bill', payBill);
router.post('/user/bank-accounts/list', getUserBankAccounts); 
router.post('/user/bank-accounts/add', addBankAccount);  
router.post('/user/upi-ids/list', getUpiIds); 
router.post('/user/upi-ids/add', addUpiId);
router.post('/user/cards/list', getCards); 
router.post('/user/cards/add', addCard);

export default router;
