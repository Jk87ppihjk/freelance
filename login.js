// login.js

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios'); // Necessário para Brevo

const router = express.Router();

// Função auxiliar para enviar Email via Brevo API (Duplicado para evitar dependência)
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
        console.log(`Email de registro enviado para ${toEmail}`);
        return response.data;
    } catch (error) {
        // Logar apenas o erro relevante sem expor a chave
        console.error("Erro ao enviar email Brevo:", error.response ? error.response.data : error.message);
    }
}


// Exporta uma função que recebe o pool de conexão e a chave secreta
module.exports = (pool, JWT_SECRET) => {

    // ROTA: Registro de Usuário
    router.post('/register', async (req, res) => {
        const { name, email, password, role } = req.body;
        
        try {
            // 1. Verificar se usuário existe
            const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
            if (users.length > 0) return res.status(400).json({ error: 'Email já cadastrado' });

            // 2. Hash da senha
            const hashedPassword = await bcrypt.hash(password, 10);

            const userRole = role ? role : 'freelancer'; // Garante o valor padrão

            // 3. Salvar no banco
            const [result] = await pool.execute(
                'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
                [name, email, hashedPassword, userRole] 
            );

            // 4. Enviar email de boas-vindas via Brevo
            await sendEmailBrevo(
                name, 
                email, 
                "Bem-vindo ao LoopMid!", 
                `<h1>Olá ${name}!</h1><p>Sua conta foi criada com sucesso.</p>`
            );

            res.status(201).json({ message: 'Usuário criado com sucesso!', userId: result.insertId });

        } catch (error) {
            console.error("Erro no Registro:", error);
            res.status(500).json({ error: 'Erro no servidor durante o registro' });
        }
    });

    // ROTA: Login
    router.post('/login', async (req, res) => {
        const { email, password } = req.body;

        try {
            const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
            if (users.length === 0) return res.status(400).json({ error: 'Usuário não encontrado' });

            const user = users[0];
            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) return res.status(400).json({ error: 'Senha incorreta' });

            // Criar Token JWT
            const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

            res.json({ token, user: { id: user.id, name: user.name, role: user.role, avatar: user.avatar_url } });

        } catch (error) {
            console.error("Erro no Login:", error);
            res.status(500).json({ error: 'Erro no servidor durante o login' });
        }
    });

    return router;
};
