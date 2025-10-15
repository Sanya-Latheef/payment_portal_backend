import { Pool, PoolConfig } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const dbConfig: PoolConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
};

const pool = new Pool(dbConfig);

pool.connect()
    .then(client => {
        console.log('✅ PostgreSQL database connected successfully!');
        client.release();
    })
    .catch(err => {
        console.error('❌ Database connection failed. Check .env credentials and server status.');
        console.error('Error details:', err.stack);
        process.exit(1);
    });

export default pool;