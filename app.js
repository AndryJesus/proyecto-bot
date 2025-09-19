import pkg from '@bot-whatsapp/bot';
const { createBot, createProvider, createFlow, addKeyword } = pkg;

import QRPortalWeb from '@bot-whatsapp/portal';
import BaileysProvider from '@bot-whatsapp/provider/baileys';
import PostgresAdapter from '@bot-whatsapp/database/postgres';
import 'dotenv/config';
import { parse } from 'pg-connection-string';

// Importar pg directamente
import { Client } from 'pg';

// Importar Socket.io CLIENTE (no Server)
import { io } from 'socket.io-client';

// Connection string de Supabase - USAR BASE DE DESARROLLO
const CONNECTION_STRING = process.env.DATABASE_DEV_URL || process.env.DATABASE_URL;

// Verificar que la variable de entorno esté configurada
if (!CONNECTION_STRING) {
    console.error('❌ ERROR: No se encontró DATABASE_DEV_URL ni DATABASE_URL en el archivo .env');
    process.exit(1);
}

console.log('🔗 Usando base de datos de desarrollo...');

// URL del servidor Socket.IO al que te quieres conectar
const SOCKET_SERVER_URL = 'https://pagina-render-wtbx.onrender.com/citas';

// Variable para la conexión Socket.IO
let socket = null;

// Variable global para controlar el estado
let userStates = {};
let dbClient = null; // Cliente de PostgreSQL
let adapterProviderInstance = null; // Instancia del proveedor para enviar mensajes

// Precios de los servicios
const servicePrices = {
    'urgencia': '$60',
    'consulta': '$25',
    'limpieza': '$15',
    'ortodoncia': '$80'
};

// Descripciones de los servicios
const serviceDescriptions = {
    'urgencia': 'Urgencia Médica',
    'consulta': 'Consulta Odontológica',
    'limpieza': 'Limpieza Dental',
    'ortodoncia': 'Evaluación de Ortodoncia'
};

// Función para conectar al servidor Socket.IO
const connectToSocketServer = () => {
    try {
        console.log(`🔌 Conectando al servidor Socket.IO: ${SOCKET_SERVER_URL}`);
        
        socket = io(SOCKET_SERVER_URL, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        socket.on('connect', () => {
            console.log('✅ Conectado al servidor Socket.IO remoto');
        });

        socket.on('disconnect', (reason) => {
            console.log(`❌ Desconectado del servidor Socket.IO: ${reason}`);
        });

        socket.on('connect_error', (error) => {
            console.error('❌ Error de conexión Socket.IO:', error.message);
        });

        socket.on('error', (error) => {
            console.error('❌ Error Socket.IO:', error);
        });

        // Escuchar eventos del servidor remoto si es necesario
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

// Función para enviar datos al servidor remoto via Socket.IO
const sendToServer = (event, data) => {
    if (socket && socket.connected) {
        socket.emit(event, data);
        console.log(`📤 Datos enviados al servidor (${event}):`, data);
        return true;
    } else {
        console.log('⚠️  Socket no conectado, intentando reconectar...');
        // Intentar reconectar
        if (socket) {
            socket.connect();
        } else {
            connectToSocketServer();
        }
        return false;
    }
};

// Función para conectar y crear la tabla
const connectAndCreateTable = async () => {
    try {
        console.log('🔌 Conectando a la base de datos de desarrollo...');
        
        dbClient = new Client({
            connectionString: CONNECTION_STRING,
            ssl: {
                rejectUnauthorized: false
            }
        });
        
        await dbClient.connect();
        console.log('✅ Conexión a PostgreSQL de desarrollo establecida');
        
        // Crear tabla si no existe
        console.log('🔄 Creando/verificando tabla de citas...');
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
        
        // Verificar si hay datos existentes
        const countResult = await dbClient.query('SELECT COUNT(*) FROM appointments');
        console.log(`✅ Tabla lista con ${countResult.rows[0].count} citas existentes`);
        
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
            console.log('📝 Cita (backup):', {
                name, phone, serviceType, appointmentDateTime, price,
                timestamp: new Date().toISOString()
            });
            return true;
        }
        
        console.log('💾 Guardando en base de datos de desarrollo...');
        
        const insertQuery = `
            INSERT INTO appointments (patient_name, patient_phone, service_type, service_price, appointment_date)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        
        const result = await dbClient.query(insertQuery, [
            name,
            phone,
            serviceType,
            price,
            appointmentDateTime
        ]);
        
        console.log('✅ Cita guardada con ID:', result.rows[0].id);
        
        // Enviar datos al servidor remoto
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

// Resto del código se mantiene igual hasta la función confirmAppointment...

// Función para confirmar una cita
const confirmAppointment = async (appointmentId) => {
    try {
        if (!dbClient) {
            console.error('❌ Cliente de BD no disponible');
            return false;
        }
        
        console.log(`✅ Confirmando cita ID: ${appointmentId}`);
        
        // Obtener información de la cita
        const selectQuery = `
            SELECT * FROM appointments 
            WHERE id = $1;
        `;
        
        const selectResult = await dbClient.query(selectQuery, [appointmentId]);
        
        if (selectResult.rows.length === 0) {
            console.error(`❌ No se encontró la cita con ID: ${appointmentId}`);
            return false;
        }
        
        const appointment = selectResult.rows[0];
        
        // Actualizar el estado de la cita en la base de datos
        const updateQuery = `
            UPDATE appointments 
            SET status = 'confirmed'
            WHERE id = $1
            RETURNING *;
        `;
        
        const updateResult = await dbClient.query(updateQuery, [appointmentId]);
        
        console.log(`✅ Cita confirmada: ${appointment.patient_name}`);
        
        // Enviar confirmación al servidor remoto
        sendToServer('appointmentConfirmed', updateResult.rows[0]);
        
        // Enviar mensaje de confirmación al usuario de WhatsApp
        if (adapterProviderInstance) {
            try {
                await adapterProviderInstance.sendText(
                    `${appointment.patient_phone}@s.whatsapp.net`,
                    `✅ *Confirmación de Cita*\n\n` +
                    `Tu cita ha sido confirmada:\n\n` +
                    `• Servicio: ${appointment.service_type}\n` +
                    `• Fecha y hora: ${appointment.appointment_date}\n` +
                    `• Precio: ${appointment.service_price}\n\n` +
                    `¡Te esperamos! 🦷`
                );
                console.log(`📤 Mensaje de confirmación enviado a: ${appointment.patient_phone}`);
            } catch (error) {
                console.error('❌ Error al enviar mensaje de WhatsApp:', error.message);
            }
        } else {
            console.error('❌ No se pudo obtener el proveedor para enviar el mensaje');
        }
        
        return true;
    } catch (error) {
        console.error('❌ Error al confirmar cita:', error.message);
        return false;
    }
};

// Eliminar toda la sección de servidor Socket.io local ya que no es necesaria
// Ya que te quieres conectar como cliente al servidor remoto

// Resto del código de flujos se mantiene igual...

// Flow para capturar nombre
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

// ... (el resto de los flujos se mantiene igual)

try {
    // Parsear la connection string
    const dbConfig = parse(CONNECTION_STRING);
    
    console.log('✅ Configuración de desarrollo parseada correctamente');
    console.log('   Host:', dbConfig.host);
    console.log('   Puerto:', dbConfig.port);
    console.log('   Database:', dbConfig.database);
    console.log('   User:', dbConfig.user);

    const main = async () => {
        console.log('🔄 Iniciando conexión a la base de datos de desarrollo...');
        
        // Conectar y crear tabla con nuestro propio cliente
        await connectAndCreateTable();
        
        // Conectar al servidor Socket.IO remoto
        connectToSocketServer();
        
        // Configurar adapter de PostgreSQL para el bot
        const adapterDB = new PostgresAdapter({
            host: dbConfig.host,
            user: dbConfig.user,
            database: dbConfig.database, 
            password: dbConfig.password,
            port: dbConfig.port,
            ssl: { 
                rejectUnauthorized: false
            }
        });
        
        const adapterFlow = createFlow([
            flowPrincipal, flowGracias, flowFallback, flowCaptureName, flowDateTime,
            flowUrgencia, flowConsulta, flowLimpieza, flowOrtodoncia, flowHistory
        ]);
        
        const adapterProvider = createProvider(BaileysProvider);

        console.log('🤖 Creando bot con base de desarrollo...');
        const bot = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        // Guardar la instancia del provider para usarla después
        adapterProviderInstance = adapterProvider;

        console.log('✅ Bot iniciado correctamente con base de desarrollo');
        console.log(`🔌 Conectado al servidor Socket.IO: ${SOCKET_SERVER_URL}`);
        
        // Cerrar conexiones al terminar
        process.on('SIGINT', async () => {
            if (dbClient) {
                await dbClient.end();
                console.log('✅ Conexión a la base de datos de desarrollo cerrada');
            }
            if (socket) {
                socket.disconnect();
                console.log('✅ Conexión Socket.IO cerrada');
            }
            process.exit(0);
        });
        
        QRPortalWeb();
    }

    main().catch(console.error);

} catch (error) {
    console.error('❌ Error al parsear connection string de desarrollo:', error);
    process.exit(1);
}