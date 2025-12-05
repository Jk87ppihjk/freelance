require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// --- 1. CONFIGURAÇÕES E LOGS INICIAIS ---

// Configuração Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração Multer (Upload de arquivos em memória)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Função para logar as variáveis (Ocultando dados sensíveis)
function logEnvironmentVariables() {
    console.log("------------------------------------------------");
    console.log(">>> SISTEMA INICIADO. VERIFICANDO VARIÁVEIS DE AMBIENTE:");
    console.log(`[BREVO] API Key: ${process.env.BREVO_API_KEY ? 'OK (Carregada)' : 'FALHA'}`);
    console.log(`[BREVO] Sender: ${process.env.BREVO_SENDER_EMAIL}`);
    console.log(`[CLOUDINARY] Cloud Name: ${process.env.CLOUDINARY_CLOUD_NAME}`);
    console.log(`[MYSQL] Host: ${process.env.DB_HOST}`);
    console.log(`[MYSQL] User: ${process.env.DB_USER}`);
    console.log(`[MYSQL] Database: ${process.env.DB_NAME}`);
    console.log(`[JWT] Secret: ${process.env.JWT_SECRET ? 'OK (Configurado)' : 'FALHA'}`);
    console.log(`[PORT] Porta: ${process.env.PORT}`);
    console.log("------------------------------------------------");
}

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

// --- 2. FUNÇÕES AUXILIARES (SERVICES) ---

// Enviar Email via Brevo API
async function sendEmailBrevo(toName, toEmail, subject, htmlContent) {
    try {
        const response = await axios.post(
            'https://api.brevo.com/v3/smtp/email',
            {
                sender: { name: "LoopMid Freelance", email: process.env.BREVO_SENDER_EMAIL },
                to: [{ email: toEmail, name: toName }],
                subject: subject,
                htmlContent: htmlContent
            },
            {
                headers: {
                    'api-key': process.env.BREVO_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`Email enviado para ${toEmail}`);
        return response.data;
    } catch (error) {
        console.error("Erro ao enviar email Brevo:", error.response ? error.response.data : error.message);
    }
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

// --- 3. MIDDLEWARE DE AUTENTICAÇÃO ---

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) return res.status(401).json({ error: 'Acesso negado' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido' });
        req.user = user;
        next();
    });
};

// --- 4. ROTAS ---

// ROTA: Teste
app.get('/', (req, res) => {
    res.send('API Freelance Marketplace Online 🚀');
});

// ROTA: Registro de Usuário
app.post('/register', async (req, res) => {
    const { name, email, password, role } = req.body;
    
    try {
        // Verificar se usuário existe
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length > 0) return res.status(400).json({ error: 'Email já cadastrado' });

        // Hash da senha
        const hashedPassword = await bcrypt.hash(password, 10);

        // Salvar no banco
        const [result] = await pool.execute(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hashedPassword, role || 'freelancer']
        );

        // Enviar email de boas-vindas via Brevo
        await sendEmailBrevo(
            name, 
            email, 
            "Bem-vindo ao LoopMid!", 
            `<h1>Olá ${name}!</h1><p>Sua conta foi criada com sucesso. Configure seu perfil para começar.</p>`
        );

        res.status(201).json({ message: 'Usuário criado com sucesso!', userId: result.insertId });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// ROTA: Login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(400).json({ error: 'Usuário não encontrado' });

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: 'Senha incorreta' });

        // Criar Token JWT
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ token, user: { id: user.id, name: user.name, role: user.role, avatar: user.avatar_url } });

    } catch (error) {
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// ROTA: Configurar Perfil (Com upload de Avatar)
app.put('/profile', authenticateToken, upload.single('avatar'), async (req, res) => {
    const { bio, skills } = req.body; // skills pode ser salvo no bio ou criar campo extra
    const userId = req.user.id;
    let avatarUrl = null;

    try {
        if (req.file) {
            const cloudRes = await uploadToCloudinary(req.file.buffer);
            avatarUrl = cloudRes.secure_url;
        }

        let query = 'UPDATE users SET bio = ?';
        let params = [bio];

        if (avatarUrl) {
            query += ', avatar_url = ?';
            params.push(avatarUrl);
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

    try {
        const [result] = await pool.execute(
            'INSERT INTO jobs (client_id, title, description, budget) VALUES (?, ?, ?, ?)',
            [req.user.id, title, description, budget]
        );
        res.status(201).json({ message: 'Job publicado!', jobId: result.insertId });
    } catch (error) {
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
// Simplificação: Freelancer clica, Job fica "in_progress" e vincula o freelancer
app.post('/jobs/:id/hire', authenticateToken, async (req, res) => {
    const jobId = req.params.id;
    const freelancerId = req.user.id;

    if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Apenas freelancers podem aceitar jobs' });

    try {
        // Verifica se job está aberto
        const [jobs] = await pool.execute('SELECT * FROM jobs WHERE id = ? AND status = "open"', [jobId]);
        if (jobs.length === 0) return res.status(404).json({ error: 'Job não disponível' });

        // Atualiza job
        await pool.execute(
            'UPDATE jobs SET freelancer_id = ?, status = "in_progress" WHERE id = ?',
            [freelancerId, jobId]
        );

        // Notificar Cliente por Email
        const [client] = await pool.execute('SELECT email, name FROM users WHERE id = ?', [jobs[0].client_id]);
        await sendEmailBrevo(
            client[0].name,
            client[0].email,
            "Seu Job foi aceito!",
            `<p>O freelancer pegou seu job "${jobs[0].title}". Agora vocês podem trocar mensagens na plataforma.</p>`
        );

        res.json({ message: 'Job aceito com sucesso! Chat liberado.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao processar contratação' });
    }
});

// ROTA: Enviar Mensagem (Apenas se houver job vinculado)
app.post('/messages', authenticateToken, async (req, res) => {
    const { jobId, content } = req.body;
    const senderId = req.user.id;

    try {
        // Verificar permissão: O usuário deve ser o cliente ou o freelancer do job
        const [job] = await pool.execute(
            'SELECT * FROM jobs WHERE id = ? AND (client_id = ? OR freelancer_id = ?)', 
            [jobId, senderId, senderId]
        );

        if (job.length === 0) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens neste job' });

        const receiverId = (senderId === job[0].client_id) ? job[0].freelancer_id : job[0].client_id;

        await pool.execute(
            'INSERT INTO messages (job_id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?)',
            [jobId, senderId, receiverId, content]
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
        // Verifica permissão
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
