import pkg from '@bot-whatsapp/bot';
const { createBot, createProvider, createFlow, addKeyword } = pkg;

import QRPortalWeb from '@bot-whatsapp/portal';
import BaileysProvider from '@bot-whatsapp/provider/baileys';
import PostgresAdapter from '@bot-whatsapp/database/postgres';
import 'dotenv/config';
import { parse } from 'pg-connection-string';

// Importar pg directamente
import { Client } from 'pg';

// Importar Socket.io CLIENTE
import { io } from 'socket.io-client';

// Importar Express para el health check
import express from 'express';

// Connection string de Supabase
const CONNECTION_STRING = process.env.DATABASE_DEV_URL || process.env.DATABASE_URL;

// Verificar que la variable de entorno esté configurada
if (!CONNECTION_STRING) {
    console.error('❌ ERROR: No se encontró DATABASE_DEV_URL ni DATABASE_URL en el archivo .env');
    process.exit(1);
}

console.log('🔗 Usando base de datos de desarrollo...');

// URL del servidor Socket.IO al que te quieres conectar
const SOCKET_SERVER_URL = 'https://pagina-render-wtbx.onrender.com';

// Configurar Express para health check
const app = express();
const PORT = process.env.PORT || 3000;

// Variable para la conexión Socket.IO
let socket = null;
let isSocketConnected = false;

// Variable global para controlar el estado
let userStates = {};
let dbClient = null;
let adapterProviderInstance = null;

// Precios y descripciones de servicios
const servicePrices = {
    'urgencia': '$60',
    'consulta': '$25',
    'limpieza': '$15',
    'ortodoncia': '$80'
};

const serviceDescriptions = {
    'urgencia': 'Urgencia Médica',
    'consulta': 'Consulta Odontológica',
    'limpieza': 'Limpieza Dental',
    'ortodoncia': 'Evaluación de Ortodoncia'
};

// Configurar middleware de Express
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'online',
        message: 'Bot de WhatsApp - Sonrisa Perfecta',
        timestamp: new Date().toISOString(),
        services: {
            whatsapp: 'active',
            websocket: isSocketConnected ? 'connected' : 'disconnected',
            database: dbClient ? 'connected' : 'disconnected'
        },
        endpoints: {
            frontend: 'https://pagina-render-wtbx.onrender.com/citas',
            health: `https://${req.hostname}/health`,
            websocket: SOCKET_SERVER_URL
        }
    });
});

// Endpoint para forzar reconexión Socket.IO
app.post('/reconnect-socket', (req, res) => {
    if (socket) {
        socket.disconnect();
        connectToSocketServer();
        res.json({ message: 'Reconexión iniciada' });
    } else {
        connectToSocketServer();
        res.json({ message: 'Conexión iniciada' });
    }
});

// Función para conectar al servidor Socket.IO
const connectToSocketServer = () => {
    try {
        console.log(`🔌 Conectando al servidor Socket.IO: ${SOCKET_SERVER_URL}`);
        
        if (socket) {
            socket.disconnect();
            socket.removeAllListeners();
        }

        socket = io(SOCKET_SERVER_URL, {
            path: '/socket.io',
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 2000,
            reconnectionDelayMax: 10000,
            timeout: 15000,
            secure: true
        });

        socket.on('connect', () => {
            console.log('✅ Conectado al servidor Socket.IO remoto');
            isSocketConnected = true;
        });

        socket.on('disconnect', (reason) => {
            console.log(`❌ Desconectado del servidor Socket.IO: ${reason}`);
            isSocketConnected = false;
        });

        socket.on('connect_error', (error) => {
            console.error('❌ Error de conexión Socket.IO:', error.message);
            isSocketConnected = false;
        });

        // Escuchar eventos del servidor
        socket.on('newAppointment', (data) => {
            console.log('📥 Nueva cita recibida del servidor:', data);
        });

        socket.on('appointmentConfirmed', (data) => {
            console.log('✅ Cita confirmada por el servidor:', data);
        });

    } catch (error) {
        console.error('❌ Error al conectar con Socket.IO:', error.message);
    }
};

// Función para enviar datos al servidor
const sendToServer = (event, data) => {
    if (socket && socket.connected) {
        socket.emit(event, data);
        console.log(`📤 Datos enviados al servidor (${event}):`, data);
        return true;
    } else {
        console.log('⚠️  Socket no conectado, guardando localmente');
        // Aquí podrías implementar una cola de mensajes pendientes
        return false;
    }
};

// Función para conectar y crear la tabla
const connectAndCreateTable = async () => {
    try {
        console.log('🔌 Conectando a la base de datos...');
        
        dbClient = new Client({
            connectionString: CONNECTION_STRING,
            ssl: {
                rejectUnauthorized: false
            }
        });
        
        await dbClient.connect();
        console.log('✅ Conexión a PostgreSQL establecida');
        
        // Crear tabla si no existe
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS appointments (
                id SERIAL PRIMARY KEY,
                patient_name VARCHAR(100) NOT NULL,
                patient_phone VARCHAR(20) NOT NULL,
                service_type VARCHAR(50) NOT NULL,
                service_price VARCHAR(20) NOT NULL,
                appointment_date VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(20) DEFAULT 'pending'
            );
        `;
        
        await dbClient.query(createTableQuery);
        console.log('✅ Tabla "appointments" creada/verificada correctamente');
        
    } catch (error) {
        console.error('❌ Error al conectar/crear tabla:', error.message);
        dbClient = null;
    }
};

// Función para guardar en la base de datos
const saveToDatabase = async (name, phone, serviceType, appointmentDateTime, price) => {
    try {
        if (!dbClient) {
            console.log('⚠️  Cliente de BD no disponible, guardando en log');
            console.log('📝 Cita (backup):', { name, phone, serviceType, appointmentDateTime, price });
            return true;
        }
        
        const insertQuery = `
            INSERT INTO appointments (patient_name, patient_phone, service_type, service_price, appointment_date)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        
        const result = await dbClient.query(insertQuery, [
            name, phone, serviceType, price, appointmentDateTime
        ]);
        
        console.log('✅ Cita guardada con ID:', result.rows[0].id);
        
        // Enviar datos al servidor
        const appointmentData = {
            id: result.rows[0].id,
            patient_name: name,
            patient_phone: phone,
            service_type: serviceType,
            service_price: price,
            appointment_date: appointmentDateTime,
            created_at: new Date().toISOString(),
            status: 'pending'
        };
        
        sendToServer('newAppointment', appointmentData);
        
        return true;
        
    } catch (error) {
        console.error('❌ Error al guardar en BD:', error.message);
        return true;
    }
};

// Función para validar formato de fecha y hora
const isValidDateTime = (datetime) => {
    const pattern = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/;
    const match = datetime.match(pattern);
    return !!match;
};

// Función para obtener historial
const getAppointmentHistory = async () => {
    try {
        if (!dbClient) return [];
        
        const query = `
            SELECT id, patient_name as nombre, patient_phone as telefono,
                   service_type as servicio, service_price as precio,
                   appointment_date as fecha, created_at as fecha_creacion,
                   status
            FROM appointments ORDER BY created_at DESC LIMIT 100
        `;
        
        const result = await dbClient.query(query);
        return result.rows;
        
    } catch (error) {
        console.error('❌ Error al obtener historial:', error.message);
        return [];
    }
};

// Función para confirmar cita
const confirmAppointment = async (appointmentId) => {
    try {
        if (!dbClient) return false;
        
        // Obtener información de la cita
        const selectResult = await dbClient.query(
            'SELECT * FROM appointments WHERE id = $1', [appointmentId]
        );
        
        if (selectResult.rows.length === 0) return false;
        
        const appointment = selectResult.rows[0];
        
        // Actualizar estado
        const updateResult = await dbClient.query(
            'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING *',
            ['confirmed', appointmentId]
        );
        
        // Enviar confirmación al servidor
        sendToServer('appointmentConfirmed', updateResult.rows[0]);
        
        // Enviar mensaje de WhatsApp
        if (adapterProviderInstance) {
            try {
                await adapterProviderInstance.sendText(
                    `${appointment.patient_phone}@s.whatsapp.net`,
                    `✅ *Confirmación de Cita*\n\nTu cita ha sido confirmada:\n\n` +
                    `• Servicio: ${appointment.service_type}\n` +
                    `• Fecha y hora: ${appointment.appointment_date}\n` +
                    `• Precio: ${appointment.service_price}\n\n¡Te esperamos! 🦷`
                );
            } catch (error) {
                console.error('❌ Error al enviar mensaje de WhatsApp:', error.message);
            }
        }
        
        return true;
    } catch (error) {
        console.error('❌ Error al confirmar cita:', error.message);
        return false;
    }
};

// FLUJOS DEL BOT
const flowCaptureName = addKeyword(['capture_name'])
    .addAnswer(
        'Por favor, indícanos tu nombre y apellido',
        { capture: true },
        async (ctx, { gotoFlow, endFlow }) => {
            const userName = ctx.body;
            const userFrom = ctx.from;
            const userState = userStates[userFrom];
            
            if (!userName || userName.length < 3 || !isNaN(userName)) {
                return endFlow('❌ Por favor, ingresa un nombre válido (mínimo 3 letras).');
            }
            
            userStates[userFrom] = {
                name: userName,
                serviceType: userState.serviceType,
                serviceDescription: serviceDescriptions[userState.serviceType],
                price: servicePrices[userState.serviceType],
                expectingDateTime: true
            };
            
            return gotoFlow(flowDateTime);
        }
    );

const flowDateTime = addKeyword(['flow_date_time'])
    .addAnswer(
        '📅 Por favor, indica la fecha y hora (Formato: *dd/mm/aaaa hh:mm*)\nEjemplo: *15/12/2024 14:30*',
        { capture: true },
        async (ctx, { endFlow }) => {
            const userFrom = ctx.from;
            const userState = userStates[userFrom];
            const dateTimeInput = ctx.body.trim();
            
            if (!userState || !userState.expectingDateTime) {
                return endFlow('❌ Ocurrió un error. Por favor, inicia el proceso nuevamente escribiendo *hola*.');
            }
            
            if (!isValidDateTime(dateTimeInput)) {
                return endFlow('❌ Formato incorrecto. Por favor, usa: *dd/mm/aaaa hh:mm*');
            }
            
            // Guardar en BD
            await saveToDatabase(
                userState.name, 
                userFrom, 
                userState.serviceDescription, 
                dateTimeInput,
                userState.price
            );

            const resumen = 
                '✅ ¡Perfecto! Hemos registrado tu información:\n\n' +
                `• Nombre: ${userState.name}\n` +
                `• Servicio: ${userState.serviceDescription}\n` +
                `• Precio: ${userState.price}\n` +
                `• Fecha y hora: ${dateTimeInput}\n\n` +
                'Un asesor se pondrá en contacto contigo para confirmar tu cita. ¡Gracias!';
            
            delete userStates[userFrom];
            return endFlow(resumen);
        }
    );

const createConfirmationFlow = (serviceType) => {
    return addKeyword([serviceType])
        .addAnswer(
            `💵 *Precio:* ${servicePrices[serviceType]}\n\n` +
            `¿Confirmas tu cita para ${serviceDescriptions[serviceType]}? Responde *sí* o *no*.`,
            { capture: true },
            async (ctx, { gotoFlow, endFlow }) => {
                const response = ctx.body.toLowerCase().trim();
                const userFrom = ctx.from;
                
                if (response === 'sí' || response === 'si' || response === 's') {
                    userStates[userFrom] = { serviceType: serviceType };
                    return gotoFlow(flowCaptureName);
                } else if (response === 'no' || response === 'n') {
                    delete userStates[userFrom];
                    return gotoFlow(flowPrincipal);
                } else {
                    return endFlow('❌ Respuesta no válida. Escribe *sí* o *no*.');
                }
            }
        );
};

const flowUrgencia = createConfirmationFlow('urgencia');
const flowConsulta = createConfirmationFlow('consulta');
const flowLimpieza = createConfirmationFlow('limpieza');
const flowOrtodoncia = createConfirmationFlow('ortodoncia');

const flowPrincipal = addKeyword(['hola', 'buenas', 'menu'])
    .addAnswer('Hola, bienvenido al *Chatbot* de Sonrisa Perfecta 👋')
    .addAnswer(
        [
            'Te damos la bienvenida a nuestra clínica odontológica.',
            'Por favor, indícanos el motivo de tu contacto:',
            `*\n1* Urgencia médica - ${servicePrices['urgencia']}`,
            `*\n2* Agendar consulta - ${servicePrices['consulta']}`,
            `*\n3* Limpieza dental - ${servicePrices['limpieza']}`,
            `*\n4* Ortodoncia - ${servicePrices['ortodoncia']}`,
        ],
        { capture: true },
        async (ctx, { gotoFlow, fallBack }) => {
            const option = ctx.body.trim();
            switch (option) {
                case '1': case 'urgencia': return gotoFlow(flowUrgencia);
                case '2': case 'consulta': return gotoFlow(flowConsulta);
                case '3': case 'limpieza': return gotoFlow(flowLimpieza);
                case '4': case 'ortodoncia': return gotoFlow(flowOrtodoncia);
                default: return fallBack('❌ Opción no válida. Selecciona 1-4.');
            }
        }
    );

const flowHistory = addKeyword(['historial', 'reportes'])
    .addAnswer(
        '🔍 Obteniendo historial de citas...',
        async (ctx, { endFlow }) => {
            const history = await getAppointmentHistory();
            if (history.length === 0) {
                return endFlow('No hay citas registradas aún.');
            }
            
            let response = '📊 Historial de Citas:\n\n';
            history.forEach((appointment, index) => {
                response += `📍 Cita ${index + 1}:\n` +
                           `   👤 Nombre: ${appointment.nombre}\n` +
                           `   📞 Teléfono: ${appointment.telefono}\n` +
                           `   🏥 Servicio: ${appointment.servicio}\n` +
                           `   💵 Precio: ${appointment.precio}\n` +
                           `   📅 Fecha: ${appointment.fecha}\n\n`;
            });
            
            return endFlow(response);
        }
    );

const flowGracias = addKeyword(['gracias']).addAnswer('De nada, ¡es un placer atenderte!');
const flowFallback = addKeyword([]).addAnswer('Lo siento, no entendí. Escribe *hola* para comenzar.');

// INICIALIZACIÓN PRINCIPAL
try {
    const dbConfig = parse(CONNECTION_STRING);
    
    console.log('✅ Configuración de base de datos parseada correctamente');

    const main = async () => {
        // Iniciar servidor Express para health check
        app.listen(PORT, () => {
            console.log(`🩺 Health check disponible en puerto ${PORT}`);
        });

        // Conectar a la base de datos
        await connectAndCreateTable();
        
        // Conectar al servidor Socket.IO
        connectToSocketServer();
        
        // Configurar adapter de PostgreSQL para el bot
        const adapterDB = new PostgresAdapter({
            host: dbConfig.host,
            user: dbConfig.user,
            database: dbConfig.database, 
            password: dbConfig.password,
            port: dbConfig.port,
            ssl: { rejectUnauthorized: false }
        });
        
        const adapterFlow = createFlow([
            flowPrincipal, flowGracias, flowFallback, flowCaptureName, flowDateTime,
            flowUrgencia, flowConsulta, flowLimpieza, flowOrtodoncia, flowHistory
        ]);
        
        // CONFIGURACIÓN CRÍTICA PARA RENDER
        const adapterProvider = createProvider(BaileysProvider, {
            // Configuración específica para Render
            usePairingCode: true, // ← ESTO ES LO MÁS IMPORTANTE
            phoneNumber: process.env.PHONE_NUMBER, // Tu número de WhatsApp
            name: 'SonrisaPerfectaBot',
            version: [2, 2323, 4], // Versión estable de WhatsApp
            printQRInTerminal: true,
            browser: ['Chrome (Linux)', '', ''],
            auth: {
                creds: {},
                keys: {}
            }
        });

        console.log('🤖 Creando bot...');
        const bot = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        adapterProviderInstance = adapterProvider;

        console.log('✅ Bot iniciado correctamente');
        console.log('📱 Usando pairing code en lugar de QR (compatible con Render)');
        console.log(`🌐 Health check: http://localhost:${PORT}/health`);
        
        // Manejar cierre graceful
        process.on('SIGINT', async () => {
            console.log('🛑 Cerrando aplicación...');
            if (dbClient) await dbClient.end();
            if (socket) socket.disconnect();
            process.exit(0);
        });
        
        // Iniciar portal web (aunque en Render el QR no funcione)
        QRPortalWeb();
    }

    main().catch(console.error);

} catch (error) {
    console.error('❌ Error al iniciar la aplicación:', error);
    process.exit(1);
}