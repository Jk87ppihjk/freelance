// server.js

require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

// Importa o módulo de login/registro
const createLoginRouter = require('./login');

const app = express();
app.use(express.json());
app.use(cors());

// --- 1. CONFIGURAÇÕES E CONEXÃO ---

const JWT_SECRET = process.env.JWT_SECRET;

// Configuração Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração Multer (Upload de arquivos em memória)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Conexão MySQL Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- Funções Auxiliares (Utilities) ---

// Função para logar as variáveis (mantida aqui, conforme solicitado)
function logEnvironmentVariables() {
    console.log("------------------------------------------------");
    console.log(">>> SISTEMA INICIADO. VERIFICANDO VARIÁVEIS DE AMBIENTE:");
    console.log(`[BREVO] API Key: ${process.env.BREVO_API_KEY ? 'OK (Carregada)' : 'FALHA'}`);
    console.log(`[BREVO] Sender: ${process.env.BREVO_SENDER_EMAIL}`);
    console.log(`[CLOUDINARY] Cloud Name: ${process.env.CLOUDINARY_CLOUD_NAME}`);
    console.log(`[MYSQL] Host: ${process.env.DB_HOST}`);
    console.log(`[MYSQL] User: ${process.env.DB_USER}`);
    console.log(`[MYSQL] Database: ${process.env.DB_NAME}`);
    console.log(`[JWT] Secret: ${JWT_SECRET ? 'OK (Configurado)' : 'FALHA'}`);
    console.log(`[PORT] Porta: ${process.env.PORT}`);
    console.log("------------------------------------------------");
}

// Upload para Cloudinary (Buffer to Stream)
async function uploadToCloudinary(fileBuffer) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { resource_type: 'auto', folder: 'freelance_avatars' },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.end(fileBuffer);
    });
}

// --- 2. MIDDLEWARE DE AUTENTICAÇÃO ---

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) return res.status(401).json({ error: 'Acesso negado' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido' });
        req.user = user;
        next();
    });
};

// --- 3. USO DO MÓDULO DE AUTENTICAÇÃO ---
const loginRouter = createLoginRouter(pool, JWT_SECRET);
// As rotas /register e /login agora estarão em /auth/register e /auth/login
app.use('/auth', loginRouter);


// --- 4. ROTAS RESTANTES (Jobs e Perfil) ---

// ROTA: Teste
app.get('/', (req, res) => {
    res.send('API Freelance Marketplace Online 🚀 (Auth movido para /auth)');
});

// ROTA: Configurar Perfil (Com upload de Avatar)
app.put('/profile', authenticateToken, upload.single('avatar'), async (req, res) => {
    const { bio } = req.body;
    const userId = req.user.id;
    let avatarUrl = null;

    try {
        if (req.file) {
            const cloudRes = await uploadToCloudinary(req.file.buffer);
            avatarUrl = cloudRes.secure_url;
        }

        // Garante que 'bio' e 'avatarUrl' sejam 'null' e não 'undefined'
        let finalBio = (bio === '' || bio === undefined) ? null : bio;

        let query = 'UPDATE users SET bio = ?';
        let params = [finalBio];

        if (avatarUrl !== null) {
            query += ', avatar_url = ?';
            params.push(avatarUrl);
        } else if (req.file === undefined && finalBio === null) {
             // Se não há arquivo e a bio é nula, não atualiza nada, mas retorna sucesso
             return res.json({ message: 'Nenhum dado fornecido para atualização.', avatar: null });
        }


        query += ' WHERE id = ?';
        params.push(userId);

        await pool.execute(query, params);

        res.json({ message: 'Perfil atualizado com sucesso', avatar: avatarUrl });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao atualizar perfil' });
    }
});

// ROTA: Criar Job (Apenas Clientes)
app.post('/jobs', authenticateToken, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Apenas clientes podem postar jobs' });

    const { title, description, budget } = req.body;
    const client_id = req.user.id;

    try {
        const [result] = await pool.execute(
            'INSERT INTO jobs (client_id, title, description, budget) VALUES (?, ?, ?, ?)',
            [client_id, title, description, budget]
        );
        res.status(201).json({ message: 'Job publicado!', jobId: result.insertId });
    } catch (error) {
        console.error("Erro ao criar job:", error);
        res.status(500).json({ error: 'Erro ao criar job' });
    }
});

// ROTA: Listar Jobs (Para Freelancers)
app.get('/jobs', async (req, res) => {
    try {
        const [jobs] = await pool.execute(`
            SELECT jobs.*, users.name as client_name 
            FROM jobs 
            JOIN users ON jobs.client_id = users.id 
            WHERE status = 'open'
        `);
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar jobs' });
    }
});

// ROTA: "Comprar"/Aplicar para Job (Contratar)
app.post('/jobs/:id/hire', authenticateToken, async (req, res) => {
    const jobId = req.params.id;
    const freelancerId = req.user.id;

    if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Apenas freelancers podem aceitar jobs' });

    try {
        const [jobs] = await pool.execute('SELECT * FROM jobs WHERE id = ? AND status = "open"', [jobId]);
        if (jobs.length === 0) return res.status(404).json({ error: 'Job não disponível' });

        await pool.execute(
            'UPDATE jobs SET freelancer_id = ?, status = "in_progress" WHERE id = ?',
            [freelancerId, jobId]
        );
        
        // (Brevo email notification logic removed for brevity, as it's not in the new login.js)
        // ... Você deve adicionar a função sendEmailBrevo de volta aqui se quiser enviar o email de notificação.

        res.json({ message: 'Job aceito com sucesso! Chat liberado.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao processar contratação' });
    }
});

// ROTA: Enviar Mensagem (Rotas de Mensagens mantidas como antes)
app.post('/messages', authenticateToken, async (req, res) => {
    const { jobId, content, receiverId } = req.body;
    const senderId = req.user.id;

    try {
        const [job] = await pool.execute(
            'SELECT * FROM jobs WHERE id = ? AND (client_id = ? OR freelancer_id = ?)', 
            [jobId, senderId, senderId]
        );

        if (job.length === 0) return res.status(403).json({ error: 'Permissão negada' });

        // Determina o destinatário
        const finalReceiverId = (senderId === job[0].client_id) ? job[0].freelancer_id : job[0].client_id;
        if (!finalReceiverId) return res.status(400).json({ error: 'O job ainda não foi aceito por um freelancer.' });

        await pool.execute(
            'INSERT INTO messages (job_id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?)',
            [jobId, senderId, finalReceiverId, content]
        );

        res.status(201).json({ message: 'Mensagem enviada' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao enviar mensagem' });
    }
});

// ROTA: Ler Mensagens de um Job
app.get('/messages/:jobId', authenticateToken, async (req, res) => {
    const { jobId } = req.params;
    const userId = req.user.id;

    try {
        const [job] = await pool.execute(
            'SELECT * FROM jobs WHERE id = ? AND (client_id = ? OR freelancer_id = ?)', 
            [jobId, userId, userId]
        );

        if (job.length === 0) return res.status(403).json({ error: 'Acesso negado' });

        const [messages] = await pool.execute(`
            SELECT messages.*, u.name as sender_name 
            FROM messages 
            JOIN users u ON messages.sender_id = u.id
            WHERE job_id = ? 
            ORDER BY created_at ASC
        `, [jobId]);

        res.json(messages);

    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
});


// --- 5. INICIALIZAÇÃO ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logEnvironmentVariables(); // Executa o log solicitado
    console.log(`Servidor rodando na porta ${PORT}`);
});
