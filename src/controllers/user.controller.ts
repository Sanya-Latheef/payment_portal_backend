import { Request, Response } from 'express';
import pool from '../database/db';
import { PoolClient } from 'pg';
import bcrypt from 'bcrypt';
import crypto from 'crypto'; 

const saltRounds = 10; 

const findRecipient = async (identifier: string) => {
    const isEmail = identifier.includes('@');
    const query = `
        SELECT user_id, first_name 
        FROM users 
        WHERE ${isEmail ? 'email_id' : 'mobile_number'} = $1;
    `;
    const result = await pool.query(query, [identifier]);
    return result.rows.length > 0 ? result.rows[0] : null;
};

export const registerUser = async (req: Request, res: Response) => {
    const { first_name, last_name, email_id, password, mobile_number, date_of_birth } = req.body;

    let client: PoolClient | null = null;

    try {
        const checkQuery = 'SELECT email_id FROM users WHERE email_id = $1 OR mobile_number = $2';
        const existingUser = await pool.query(checkQuery, [email_id, mobile_number]);

        if (existingUser.rows.length > 0) {
            return res.status(409).json({ error: 'User with this email or mobile number already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, saltRounds);

        client = await pool.connect();
        await client.query('BEGIN'); 

        const insertUserQuery = `
            INSERT INTO users (first_name, last_name, email_id, password, mobile_number, date_of_birth)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING user_id, first_name, last_name, email_id, created_at;
        `;
        const userResult = await client.query(insertUserQuery, [
            first_name,
            last_name,
            email_id,
            hashedPassword,
            mobile_number,
            date_of_birth
        ]);
        const newUser = userResult.rows[0];
        const newUserId = newUser.user_id;

        const insertBalanceQuery = `
            INSERT INTO account_balances (user_id, amount)
            VALUES ($1, 0.00);
        `;
        await client.query(insertBalanceQuery, [newUserId]);

        await client.query('COMMIT');

        return res.status(201).json({
            message: 'Registration successful! Wallet initialized.',
            user: {
                user_id: newUser.user_id,
                first_name: newUser.first_name,
                email_id: newUser.email_id,
                created_at: newUser.created_at ? newUser.created_at.toISOString() : null, 
            },
        });
    } catch (error) {
        if (client) {
            console.error('TRANSACTION FAILED: Attempting ROLLBACK. Error details:', error);
            await client.query('ROLLBACK'); 
        }
        return res.status(500).json({ error: 'Internal server error. Registration failed during final database commit/cleanup.' });
    } finally {
        if (client) {
            client.release(); 
        }
    }
};

export const loginUser = async (req: Request, res: Response) => {
    const { email_id: loginIdentifier, password } = req.body;

    try {
        const isEmail = loginIdentifier.includes('@');
        
        let userQuery: string;
        let queryParams: string[];

        const fieldsToRetrieve = 'user_id, password, first_name, email_id, mobile_number';

        if (isEmail) {
            userQuery = `SELECT ${fieldsToRetrieve} FROM users WHERE email_id = $1`;
            queryParams = [loginIdentifier];
        } else {
            userQuery = `SELECT ${fieldsToRetrieve} FROM users WHERE mobile_number = $1`;
            queryParams = [loginIdentifier];
        }

        const result = await pool.query(userQuery, queryParams);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email/mobile number or password.' });
        }

        const user = result.rows[0];
        const storedHash = user.password;

        const isMatch = await bcrypt.compare(password, storedHash);

        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email/mobile number or password.' });
        }

        return res.status(200).json({
            message: 'Login successful!',
            user: {
                user_id: user.user_id,
                first_name: user.first_name,
                email_id: user.email_id,
            }
        });

    } catch (error) {
        console.error('Error during login:', error);
        return res.status(500).json({ error: 'Internal server error during login.' });
    }
};

export const addFunds = async (req: Request, res: Response) => {
    const { user_id, amount, bank_account_id } = req.body; 
    const depositAmount = parseFloat(amount);

    if (!user_id || depositAmount <= 0) {
        return res.status(400).json({ error: 'Valid user ID and positive amount required.' });
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const updateBalanceQuery = `
            UPDATE account_balances
            SET 
                amount = amount + $1,
                last_updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2
            RETURNING amount;
        `;
        const balanceResult = await client.query(updateBalanceQuery, [depositAmount, user_id]);
        
        const logTransactionQuery = `
            INSERT INTO transactions 
                (user_id, type, amount, description, status, last_updated_at)
            VALUES ($1, 'CREDIT', $2, $3, $4, CURRENT_TIMESTAMP);
        `;
        await client.query(logTransactionQuery, [user_id, depositAmount, 'Wallet Deposit (External)', 'COMPLETED']);

        await client.query('COMMIT');

        return res.status(200).json({
            message: 'Funds deposited successfully.',
            new_balance: balanceResult.rows[0].amount,
        });

    } catch (error) {
        if (client) {
            console.error('TRANSACTION FAILED: Attempting ROLLBACK for Add Funds. Error details:', error);
            await client.query('ROLLBACK');
        }
        return res.status(500).json({ error: 'Internal server error: Deposit failed.' });
    } finally {
        if (client) {
            client.release();
        }
    }
};

export const getUserBankAccounts = async (req: Request, res: Response) => {
    const { user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: 'Valid user_id is required.' });
    }

    try {
        const query = `
            SELECT 
                account_id,
                bank_name,
                -- Mask account number for security, showing only last 4 digits
                RIGHT(account_number, 4) AS masked_account,
                is_primary,
                account_holder_name
            FROM user_bank_accounts
            WHERE user_id = $1
            ORDER BY is_primary DESC, bank_name ASC;
        `;
        const result = await pool.query(query, [user_id]);

        return res.status(200).json({
            message: 'Bank accounts retrieved successfully.',
            accounts: result.rows,
        });

    } catch (error) {
        console.error('Error retrieving bank accounts:', error);
        return res.status(500).json({ error: 'Internal server error while fetching bank accounts.' });
    }
};

export const addBankAccount = async (req: Request, res: Response) => {
    const { user_id, bank_name, account_number, ifsc_code, account_holder_name } = req.body;

    if (!user_id || !bank_name || !account_number || !ifsc_code || !account_holder_name) {
        return res.status(400).json({ error: 'All bank account fields are required.' });
    }

    try {
        const query = `
            INSERT INTO user_bank_accounts (user_id, bank_name, account_number, ifsc_code, account_holder_name)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING account_id, bank_name;
        `;
        const result = await pool.query(query, [user_id, bank_name, account_number, ifsc_code, account_holder_name]);

        return res.status(201).json({
            message: 'Bank account added successfully.',
            account: result.rows[0],
        });

    } catch (error) {
        console.error('Error adding bank account:', error); 
        
        if (typeof error === 'object' && error !== null && 'code' in error) {
            if (error.code === '23505') {
                 return res.status(409).json({ error: 'This bank account is already linked to your profile.' });
            }
        }
        
        return res.status(500).json({ error: 'Internal server error while adding account.' });
    }
};

export const getUpiIds = async (req: Request, res: Response) => {
    const { user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: 'Valid user_id is required.' });
    }

    try {
        const query = `
            SELECT 
                upi_id,
                vpa,
                is_primary
            FROM user_upi_ids
            WHERE user_id = $1
            ORDER BY is_primary DESC, created_at DESC;
        `;
        const result = await pool.query(query, [user_id]);

        return res.status(200).json({
            message: 'UPI IDs retrieved successfully.',
            accounts: result.rows,
        });

    } catch (error) {
        console.error('Error retrieving UPI IDs:', error);
        return res.status(500).json({ error: 'Internal server error while fetching UPI IDs.' });
    }
};

export const addUpiId = async (req: Request, res: Response) => {
    const { user_id, vpa } = req.body;

    if (!user_id || !vpa) {
        return res.status(400).json({ error: 'User ID and VPA are required.' });
    }
    
    try {
        const query = `
            INSERT INTO user_upi_ids (user_id, vpa)
            VALUES ($1, $2)
            RETURNING upi_id, vpa;
        `;
        const result = await pool.query(query, [user_id, vpa.trim().toLowerCase()]);

        return res.status(201).json({
            message: 'UPI ID added successfully.',
            upi_id: result.rows[0],
        });

    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
            if (error.code === '23505') {
                 return res.status(409).json({ error: 'This UPI ID is already linked to your profile.' });
            }
        }
        console.error('Error adding UPI ID:', error);
        return res.status(500).json({ error: 'Internal server error while adding UPI ID.' });
    }
};

export const getCards = async (req: Request, res: Response) => {
    const { user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: 'Valid user_id is required.' });
    }

    try {
        const query = `
            SELECT 
                card_id,
                masked_card_number,
                card_type,
                expiry_date,
                is_primary
            FROM user_cards
            WHERE user_id = $1
            ORDER BY is_primary DESC, created_at DESC;
        `;
        const result = await pool.query(query, [user_id]);

        return res.status(200).json({
            message: 'Cards retrieved successfully.',
            cards: result.rows,
        });

    } catch (error) {
        console.error('Error retrieving cards:', error);
        return res.status(500).json({ error: 'Internal server error while fetching cards.' });
    }
};

export const addCard = async (req: Request, res: Response) => {
    const { user_id, card_number, card_type, expiry_date, cvv } = req.body;

    if (!user_id || !card_number || !card_type || !expiry_date || !cvv) {
        return res.status(400).json({ error: 'All card fields are required.' });
    }
    
    if (card_type !== 'DEBIT' && card_type !== 'CREDIT') {
         return res.status(400).json({ error: 'Card Type must be either DEBIT or CREDIT.' });
    }

    const maskedCard = card_number.slice(-4);
    
    try {
        const query = `
            INSERT INTO user_cards (user_id, masked_card_number, card_type, expiry_date, token)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING card_id, card_type, masked_card_number;
        `;

        const simulatedToken = crypto.randomBytes(16).toString('hex'); 
        
        const result = await pool.query(query, [user_id, maskedCard, card_type, expiry_date, simulatedToken]);

        return res.status(201).json({
            message: 'Card added successfully (Tokenized).',
            card: result.rows[0],
        });

    } catch (error) {
        console.error('Error adding card:', error);
        return res.status(500).json({ error: 'Internal server error while adding card.' });
    }
};

export const getUserProfileAndBalance = async (req: Request, res: Response) => {
    const { email_id } = req.body;

    if (!email_id) {
        return res.status(400).json({ error: 'Missing email_id in request body.' });
    }

    try {
        const profileQuery = `
            SELECT 
                u.user_id,
                u.first_name,
                u.last_name,
                u.email_id,
                u.mobile_number,
                b.amount AS current_balance,
                b.last_updated_at AS balance_last_updated
            FROM users u
            JOIN account_balances b ON u.user_id = b.user_id
            WHERE u.email_id = $1;
        `;

        const result = await pool.query(profileQuery, [email_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User profile or balance account not found.' });
        }

        const user = result.rows[0];

        return res.status(200).json({
            message: 'User profile and balance retrieved successfully.',
            user: {
                id: user.user_id,
                firstName: user.first_name,
                lastName: user.last_name,
                emailId: user.email_id,
                mobileNumber: user.mobile_number,
                currentBalance: user.current_balance, 
                balanceLastUpdated: user.balance_last_updated,
            },
        });

    } catch (error) {
        console.error('Error retrieving user profile and balance:', error);
        return res.status(500).json({ error: 'Internal server error while fetching data.' });
    }
};

export const getUserTransactions = async (req: Request, res: Response) => {
    const { user_id } = req.body;

    if (!user_id || typeof user_id !== 'number') {
        return res.status(400).json({ error: 'Valid user_id is required to fetch transactions.' });
    }

    try {
        const transactionQuery = `
            SELECT 
                transaction_id,
                type,
                amount,
                status,
                description,
                created_at,
                last_updated_at,
                counterparty_id
            FROM transactions
            WHERE user_id = $1
            ORDER BY created_at DESC;
        `;

        const result = await pool.query(transactionQuery, [user_id]);

        const transactions = result.rows.map(tx => ({
            id: tx.transaction_id,
            type: tx.type,
            amount: tx.amount,
            status: tx.status,
            description: tx.description,
            createdAt: tx.created_at ? tx.created_at.toISOString() : null,
            lastUpdatedAt: tx.last_updated_at ? tx.last_updated_at.toISOString() : null,
            counterpartyId: tx.counterparty_id,
        }));

        return res.status(200).json({
            message: 'Transaction history retrieved successfully.',
            transactions: transactions,
        });

    } catch (error) {
        console.error('Error retrieving user transactions:', error);
        return res.status(500).json({ error: 'Internal server error while fetching transaction history.' });
    }
};

export const payBill = async (req: Request, res: Response) => {
    const { user_id, merchant_id, amount, description, payment_method } = req.body;
    const paymentAmount = parseFloat(amount);

    if (!user_id || !merchant_id || paymentAmount <= 0) {
        return res.status(400).json({ error: 'Valid user ID, merchant ID, and positive amount required.' });
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN'); 

        const senderBalanceQuery = `
            SELECT amount FROM account_balances 
            WHERE user_id = $1 FOR UPDATE;
        `;
        const senderBalanceResult = await pool.query(senderBalanceQuery, [user_id]);
        
        if (senderBalanceResult.rows.length === 0 || parseFloat(senderBalanceResult.rows[0].amount) < paymentAmount) {
            await client.query('ROLLBACK');
            return res.status(402).json({ error: 'Insufficient funds for this payment.' });
        }

        const logDebitQuery = `
            INSERT INTO transactions 
                (user_id, type, amount, description, status, last_updated_at)
            VALUES ($1, 'DEBIT', $2, $3, $4, CURRENT_TIMESTAMP);
        `;
        const finalDescription = `${description}`; 
        
        await client.query(logDebitQuery, [
            user_id, 
            paymentAmount, 
            finalDescription, 
            'COMPLETED' 
        ]);

        await client.query('COMMIT');

        const newBalanceQuery = `SELECT amount FROM account_balances WHERE user_id = $1;`;
        const newBalanceResult = await pool.query(newBalanceQuery, [user_id]);

        return res.status(200).json({
            message: `Payment of ₹${paymentAmount.toFixed(2)} to ${merchant_id} successful.`,
            new_balance: newBalanceResult.rows[0].amount,
        });

    } catch (error) {
        if (client) {
            console.error('PAYMENT FAILED: Attempting ROLLBACK for Bill Payment. Error details:', error);
            await client.query('ROLLBACK');
        }
        return res.status(500).json({ error: 'Internal server error: Payment processing failed.' });
    } finally {
        if (client) {
            client.release();
        }
    }
};

export const sendMoney = async (req: Request, res: Response) => {
    const { sender_id, recipient_identifier, amount } = req.body;
    const transferAmount = parseFloat(amount);

    if (!sender_id || !recipient_identifier || transferAmount <= 0) {
        return res.status(400).json({ error: 'Sender ID, recipient, and positive amount required.' });
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN'); 

        const recipient = await findRecipient(recipient_identifier);

        if (!recipient) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Recipient not found.' });
        }
        const recipientId = recipient.user_id;
        const recipientName = recipient.first_name;

        if (sender_id === recipientId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Cannot send money to yourself.' });
        }

        const senderBalanceQuery = `
            SELECT amount FROM account_balances 
            WHERE user_id = $1 FOR UPDATE;
        `;
        const senderBalanceResult = await client.query(senderBalanceQuery, [sender_id]);
        
        if (senderBalanceResult.rows.length === 0 || parseFloat(senderBalanceResult.rows[0].amount) < transferAmount) {
            await client.query('ROLLBACK');
            return res.status(402).json({ error: 'Insufficient funds.' });
        }

        const debitQuery = `
            UPDATE account_balances
            SET 
                amount = amount - $1,
                last_updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2;
        `;
        await client.query(debitQuery, [transferAmount, sender_id]);

        const creditQuery = `
            UPDATE account_balances
            SET 
                amount = amount + $1,
                last_updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2;
        `;
        await client.query(creditQuery, [transferAmount, recipientId]);

        const logDebitQuery = `
            INSERT INTO transactions 
                (user_id, type, amount, description, counterparty_id, status, last_updated_at)
            VALUES ($1, 'DEBIT', $2, $3, $4, $5, CURRENT_TIMESTAMP);
        `;

        await client.query(logDebitQuery, [
            sender_id, 
            transferAmount, 
            `Transfer to ${recipientName} (P2P)`, 
            recipientId,
            'COMPLETED'
        ]);

        const logCreditQuery = `
            INSERT INTO transactions 
                (user_id, type, amount, description, counterparty_id, status, last_updated_at)
            VALUES ($1, 'CREDIT', $2, $3, $4, $5, CURRENT_TIMESTAMP);
        `;
        const senderNameResult = await pool.query('SELECT first_name FROM users WHERE user_id = $1', [sender_id]);
        const senderName = senderNameResult.rows[0].first_name;

        await client.query(logCreditQuery, [
            recipientId, 
            transferAmount, 
            `Transfer from ${senderName} (P2P)`, 
            sender_id,
            'COMPLETED'
        ]);


        await client.query('COMMIT'); 

        const newSenderBalanceQuery = `
            SELECT amount FROM account_balances 
            WHERE user_id = $1;
        `;
        const newSenderBalanceResult = await pool.query(newSenderBalanceQuery, [sender_id]);

        return res.status(200).json({
            message: `Successfully transferred ₹${transferAmount.toFixed(2)} to ${recipientName}.`,
            new_balance: newSenderBalanceResult.rows[0].amount,
        });

    } catch (error) {
        if (client) {
            console.error('P2P TRANSACTION FAILED: Attempting ROLLBACK. Error details:', error);
            await client.query('ROLLBACK');
        }
        return res.status(500).json({ error: 'Internal server error: P2P transfer failed.' });
    } finally {
        if (client) {
            client.release();
        }
    }
};
