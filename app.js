import pkg from '@bot-whatsapp/bot';
const { createBot, createProvider, createFlow, addKeyword } = pkg;

import QRPortalWeb from '@bot-whatsapp/portal';
import BaileysProvider from '@bot-whatsapp/provider/baileys';
import PostgresAdapter from '@bot-whatsapp/database/postgres';
import 'dotenv/config';
import { parse } from 'pg-connection-string';

// Importar pg directamente
import { Client } from 'pg';

// Importar Socket.io
import { Server } from 'socket.io';
import http from 'http';
import express from 'express';

// Configuración de entorno
const isProduction = process.env.NODE_ENV === 'production';
const FRONTEND_URL = isProduction 
  ? 'https://pagina-render-wtbx.onrender.com' 
  : 'http://localhost:4321';

// Connection string de Supabase
const CONNECTION_STRING = process.env.DATABASE_URL;

// Verificar que la variable de entorno esté configurada
if (!CONNECTION_STRING) {
    console.error('❌ ERROR: No se encontró DATABASE_URL en el archivo .env');
    process.exit(1);
}

console.log(`🌍 Modo: ${isProduction ? 'Producción' : 'Desarrollo'}`);
console.log(`🔗 Frontend: ${FRONTEND_URL}`);

// Configuración de Express y Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Render asigna el puerto automáticamente mediante process.env.PORT
const WS_PORT = process.env.PORT || 3002;
server.listen(WS_PORT, () => {
  console.log(`🚀 Servidor de WebSockets ejecutándose en puerto ${WS_PORT}`);
  console.log(`📡 Frontend conectará desde: ${FRONTEND_URL}`);
});

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

// Función para enviar datos al frontend via WebSocket
const sendToFrontend = (data) => {
  io.emit('newAppointment', data);
  console.log('📤 Datos enviados al frontend via WebSocket');
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
        
        console.log('💾 Guardando en base de datos...');
        
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
        
        // Enviar datos al frontend
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
        
        sendToFrontend(appointmentData);
        
        return true;
        
    } catch (error) {
        console.error('❌ Error al guardar en BD:', error.message);
        return true;
    }
};

// Función para obtener el historial
const getAppointmentHistory = async () => {
    try {
        if (!dbClient) {
            console.log('⚠️  Cliente de BD no disponible');
            return [];
        }
        
        console.log('📊 Obteniendo historial...');
        
        const query = `
            SELECT 
                id,
                patient_name as nombre,
                patient_phone as telefono,
                service_type as servicio,
                service_price as precio,
                appointment_date as fecha,
                created_at as fecha_creacion,
                status
            FROM appointments 
            ORDER BY created_at DESC
            LIMIT 100
        `;
        
        const result = await dbClient.query(query);
        console.log(`✅ ${result.rows.length} citas encontradas`);
        return result.rows;
        
    } catch (error) {
        console.error('❌ Error al obtener historial:', error.message);
        return [];
    }
};

// Función para validar formato de fecha y hora
const isValidDateTime = (datetime) => {
    const pattern = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/;
    const match = datetime.match(pattern);
    
    if (!match) return false;
    
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const hour = parseInt(match[4], 10);
    const minute = parseInt(match[5], 10);
    
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    if (hour < 0 || hour > 23) return false;
    if (minute < 0 || minute > 59) return false;
    
    return true;
};

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
        
        // Notificar al frontend sobre la confirmación
        io.emit('appointmentConfirmed', updateResult.rows[0]);
        
        return true;
    } catch (error) {
        console.error('❌ Error al confirmar cita:', error.message);
        return false;
    }
};

// Función para enviar todas las citas al frontend cuando se conecte
const sendAllAppointmentsToFrontend = async (socket) => {
    try {
        const appointments = await getAppointmentHistory();
        socket.emit('allAppointments', appointments);
        console.log(`📊 Enviadas ${appointments.length} citas existentes al frontend`);
    } catch (error) {
        console.error('❌ Error al enviar citas existentes:', error.message);
    }
};

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

// Flow para capturar fecha y hora
const flowDateTime = addKeyword(['flow_date_time'])
    .addAnswer(
        '📅 Por favor, indica la fecha y hora en la que prefieres asistir.\n\n' +
        'Formato: *dd/mm/aaaa hh:mm*\n' +
        'Ejemplo: *15/12/2024 14:30*',
        { capture: true },
        async (ctx, { endFlow }) => {
            const userFrom = ctx.from;
            const userState = userStates[userFrom];
            const dateTimeInput = ctx.body.trim();
            
            if (!userState || !userState.expectingDateTime) {
                return endFlow('❌ Ocurrió un error. Por favor, inicia el proceso nuevamente escribiendo *hola*.');
            }
            
            if (!isValidDateTime(dateTimeInput)) {
                return endFlow('❌ Formato incorrecto. Por favor, usa el formato: *dd/mm/aaaa hh:mm*\nEjemplo: *15/12/2024 14:30*');
            }
            
            userStates[userFrom].appointmentDateTime = dateTimeInput;
            userStates[userFrom].expectingDateTime = false;
            
            // Guardar en la base de datos
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

// Función para crear flujos de confirmación con precios
const createConfirmationFlow = (serviceType) => {
    return addKeyword([serviceType])
        .addAnswer(
            `💵 *Precio del servicio:* ${servicePrices[serviceType]}\n\n` +
            `¿Deseas confirmar tu cita para ${serviceDescriptions[serviceType]}? Responde con *sí* para confirmar o *no* para elegir otro servicio.`,
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
                    return endFlow('❌ Respuesta no válida. Por favor, escribe *sí* para confirmar o *no* para elegir otro servicio.');
                }
            }
        );
};

// Crear flujos de confirmación para cada servicio
const flowUrgencia = createConfirmationFlow('urgencia');
const flowConsulta = createConfirmationFlow('consulta');
const flowLimpieza = createConfirmationFlow('limpieza');
const flowOrtodoncia = createConfirmationFlow('ortodoncia');

// Flow principal
const flowPrincipal = addKeyword(['hola', 'buenas', 'menu'])
    .addAnswer('Hla, bienvenido al *Chatbot* de Sonrisa Perfecta 👋')
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
                default: return fallBack('❌ Opción no válida. Por favor, selecciona un número del 1 al 4.');
            }
        }
    );

// Flow para ver historial
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
                           `   📅 Fecha: ${appointment.fecha}\n` +
                           `   ⏰ Registrado: ${new Date(appointment.fecha_creacion).toLocaleString()}\n\n`;
            });
            
            return endFlow(response);
        }
    );

const flowGracias = addKeyword(['gracias']).addAnswer('De nada, ¡es un placer atenderte!');
const flowFallback = addKeyword([]).addAnswer('Lo siento, no entendí. Escribe *hola* para comenzar.');

// Configurar eventos de Socket.io
io.on('connection', (socket) => {
    console.log('🔌 Cliente frontend conectado');
    
    // Enviar todas las citas existentes al nuevo cliente
    sendAllAppointmentsToFrontend(socket);
    
    // Manejar confirmación de cita desde el frontend
    socket.on('confirmAppointment', async (appointmentId) => {
        console.log(`📋 Solicitud de confirmación para cita ID: ${appointmentId}`);
        const success = await confirmAppointment(appointmentId);
        
        // Enviar respuesta al frontend
        socket.emit('confirmationResult', {
            success,
            appointmentId,
            message: success ? 'Cita confirmada exitosamente' : 'Error al confirmar la cita'
        });
    });
    
    socket.on('disconnect', () => {
        console.log('🔌 Cliente frontend desconectado');
    });
});

try {
    // Parsear la connection string
    const dbConfig = parse(CONNECTION_STRING);
    
    console.log('✅ Configuración de base de datos parseada correctamente');
    console.log('   Host:', dbConfig.host);
    console.log('   Database:', dbConfig.database);

    const main = async () => {
        console.log('🔄 Iniciando conexión a la base de datos...');
        
        // Conectar y crear tabla con nuestro propio cliente
        await connectAndCreateTable();
        
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

        console.log('🤖 Creando bot...');
        const bot = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        // Guardar la instancia del provider para usarla después
        adapterProviderInstance = adapterProvider;

        console.log('✅ Bot iniciado correctamente');
        console.log(`🌐 Servidor de WebSockets escuchando en puerto ${WS_PORT}`);
        console.log(`📱 Frontend conectando desde: ${FRONTEND_URL}`);
        
        // Cerrar conexión al terminar
        process.on('SIGINT', async () => {
            if (dbClient) {
                await dbClient.end();
                console.log('✅ Conexión a la base de datos cerrada');
            }
            server.close(() => {
                console.log('✅ Servidor de WebSockets cerrado');
                process.exit(0);
            });
        });
        
        QRPortalWeb();
    }

    main().catch(console.error);

} catch (error) {
    console.error('❌ Error al parsear connection string:', error);
    process.exit(1);
}