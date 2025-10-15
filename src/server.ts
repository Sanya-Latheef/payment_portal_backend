import express, { Request, Response } from 'express';
import { json, urlencoded } from 'body-parser';
import * as dotenv from 'dotenv';
import userRoutes from './routes/user.routes'; 
import pool from './database/db';

dotenv.config();

const app = express();
const port = process.env.SERVER_PORT || 3000;

app.use(json()); 
app.use(urlencoded({ extended: true })); 

app.use((req: Request, res: Response, next: () => void) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

app.use('/', userRoutes); 

app.get('/', (req: Request, res: Response) => {
    res.status(200).json({ message: 'Payment Portal API is running.' });
});

app.listen(port, () => {
    console.log(`🚀 TypeScript Node.js server running on http://localhost:${port}`);
    console.log(`Routes: /register, /login, /user/profile`);
});
