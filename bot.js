import { Client, GatewayIntentBits, Collection, Events, Partials } from 'discord.js';
import { OpenAI } from "openai";
import axios from 'axios';
import { config } from 'dotenv';
import FormData from 'form-data';
import fs from 'fs';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { SlashCommandBuilder } from '@discordjs/builders';

const OPENAIMODEL = "gpt-4o-2024-08-06"; // Modelo del asistente
const BOTVERSION = "v2.4"; // Version del BOT
const BOTLOG = "log.txt"
const BOTLOGDOCKER = '/var/log/discord-bot/' + BOTLOG 
// const logStream = fs.createWriteStream(BOTLOG, { flags: 'a' }); // 'a' para agregar al archivo existente
const logStream = fs.createWriteStream(BOTLOGDOCKER, { flags: 'a' }); // 'a' para agregar al archivo existente

//Redirige console.log a un archivo
console.log = (message, adicional) => {
    // Verifica si 'adicional' es undefined
    if (typeof adicional === 'undefined') {
        logStream.write(message + '\n'); // Solo escribe el mensaje
    } else {
        logStream.write(message + ' ' + adicional + '\n'); // Escribe el mensaje y adicional
    }
};

//Redirige console.error a un archivo
console.error = (message, adicional) => {
    // Verifica si 'adicional' es undefined
    if (typeof adicional === 'undefined') {
        logStream.write(message + '\n'); // Solo escribe el mensaje
    } else {
        logStream.write(message + ' ' + adicional + '\n'); // Escribe el mensaje y adicional
    }
};

// Carga las variables env en el sistema
config({ override: true })

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const threadMap = {};

const terminalStates = ["cancelled", "failed", "completed", "expired"];

// Discord Client Intents permitidos
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.GuildMessageTyping
    ],
    partials: [Partials.Channel]
});

//Sleep function
const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const getOpenAiThreadId = (discordThreadId) => {
    // Replace this in-memory implementation with a database (e.g. DynamoDB, Firestore, Redis)
    return threadMap[discordThreadId];
}

const addThreadToMap = (discordThreadId, openAiThreadId) => {
    threadMap[discordThreadId] = openAiThreadId;
}

const statusCheckLoop = async (openAiThreadId, runId) => {
    try {
        const run = await openai.beta.threads.runs.retrieve(
            openAiThreadId,
            runId
        );

        if (terminalStates.indexOf(run.status) < 0) {
            await sleep(100);
            return statusCheckLoop(openAiThreadId, runId);
        }

        // console.log(run);
        return run.status;
    } catch (error) {
        console.error("Error in statusCheckLoop: ", error);
        throw error;
    }
}

const addMessage = async (threadId, content) => {
    try {
        console.log("Contenido-->", content);
        return openai.beta.threads.messages.create(
            threadId,
            { role: "user", content }
        );
    } catch (error) {
        console.error("Error in addMessage: ", error);
        throw error;
    }
}


// If file is attached upload it to assistant
async function UploadAssistantFile(message) {
    console.log("Archivo recibido...");

    let filesToAssistant = [];
    try {
        // Recupera los datos del asistente
        const myAssistant = await openai.beta.assistants.retrieve(process.env.ASSISTANT_ID); // Reemplaza "asst_abc123" con el ID real de tu asistente
        //console.log("Datos del asistente:", myAssistant);
        // Lista los archivos del recurso tool_resources
        if (myAssistant.tool_resources.code_interpreter && myAssistant.tool_resources.code_interpreter.file_ids.length > 0) {
            console.log('Archivos enlazados al asistente:');
            filesToAssistant = myAssistant.tool_resources.code_interpreter.file_ids; // Almacena los IDs en el array
            filesToAssistant.forEach(resource => {
                console.log(`- ID: ${resource}`);
            })
        } else {
            console.log('No se encontraron archivos enlazados al asistente.');
        }
    } catch (error) {
        console.error('Error al recuperar los datos del asistente:', error);
    }

    const attachments = Array.from(message.attachments.values());
    for (const attachment of attachments) {
        try {
            console.log("Descargando Archivo recibido...");
            //const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            const response = await axios.get(attachment.url, { responseType: 'stream' });

            // Crear un FormData para enviar el archivo a OpenAI
            const formData = new FormData();
            formData.append('file', response.data, attachment.name);
            formData.append('purpose', 'assistants');

            // Obtener headers de formData para la solicitud personalizada
            const formHeaders = formData.getHeaders();

            console.log("Enviando al Storage archivo recibido...");
            // Enviar el archivo a la API de OpenAI usando axios
            const response_file = await axios.post('https://api.openai.com/v1/files', formData, {
                headers: {
                    'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
                    ...formHeaders
                }
            });
            filesToAssistant.push(response_file.data.id)
            console.log("File ID-->", response_file.data.id);
        } catch (error) {
            console.error("Error al manejar el archivo adjunto:", error);
        }
    }
    if (filesToAssistant.length > 0) {
        // Update the assistant with the new file ID
        await openai.beta.assistants.update(
            process.env.ASSISTANT_ID,
            {
                tools: [{ type: "code_interpreter" }],
                tool_resources: { code_interpreter: { file_ids: filesToAssistant } },
                model: OPENAIMODEL
            }
        );
        console.log("Enlazados los archivos al asistente...");
    }
}

async function SendMessageToAssistant(message) {
    try {
        console.log("Mensaje-->", message.content);
        const discordThreadId = message.channel.id;
        let openAiThreadId = getOpenAiThreadId(discordThreadId);
        let messagesLoaded = false;

        if (!openAiThreadId) {
            const thread = await openai.beta.threads.create();
            openAiThreadId = thread.id;
            addThreadToMap(discordThreadId, openAiThreadId);

            if (message.channel.isThread()) {
                //Gather all thread messages to fill out the OpenAI thread since we haven't seen this one yet
                const starterMsg = await message.channel.fetchStarterMessage();
                const otherMessagesRaw = await message.channel.messages.fetch();
                const otherMessages = Array.from(otherMessagesRaw.values())
                    .map(msg => msg.content)
                    .reverse(); //oldest first

                const messages = [starterMsg.content, ...otherMessages]
                    .filter(msg => !!msg && msg !== '')

                console.log("Mensaje Thread-->", messages);
                await Promise.all(messages.map(msg => addMessage(openAiThreadId, msg)));
                messagesLoaded = true;
            }
        }

        console.log("OpenAI Thread--", openAiThreadId);

        if (!messagesLoaded) {
            //If this is for a thread, assume msg was loaded via .fetch() earlier
            await addMessage(openAiThreadId, message.content);
        }

        const run = await openai.beta.threads.runs.create(
            openAiThreadId,
            { assistant_id: process.env.ASSISTANT_ID }
        )

        const status = await statusCheckLoop(openAiThreadId, run.id);
        const messages = await openai.beta.threads.messages.list(openAiThreadId);
        let response = messages.data[0].content[0].text.value;

        console.log("Respuesta-->", response);
        if (response.length <= 1993) {
            response = `\`\`\`${response.substring(0, 1993)}\`\`\`` /*Discord msg length limit when I was testing*/
            await message.reply({ content: response }).catch(console.error);
        }
        else { //Para superar los 2000 caracteres maximo de Discord (divide el mensaje en maximo 3 de 2000 chars c/u
            await message.reply({ content: `\`\`\`${response.substring(0, 1993)}\`\`\`` }).catch(console.error);
            await message.reply({ content: `\`\`\`${response.substring(1993, 3986)}\`\`\`` }).catch(console.error);
            await message.reply({ content: `\`\`\`${response.substring(3986)}\`\`\`` }).catch(console.error);
        }

        message.channel.sendTyping();

        // Si la respuesta genero un archivo para descarga
        if (messages.data[0].attachments[0]) {
            //Obtenemos el id del archivo generado
            const fileId = messages.data[0].attachments[0].file_id;
            //informacion del archivo generado en el store de openai (url)
            const fileInfo = await openai.files.content(fileId);
            console.log("File url-->", fileInfo.url);
            // Descargar el archivo desde la URL obtenida
            const fileResponse = await axios.get(fileInfo.url, {
                responseType: 'arraybuffer', headers: {
                    'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
                }
            });
            //contenido del archivo obtenido (filename)
            const fileObj = await openai.files.retrieve(fileId);
            //enviar el archivo a Discord
            await message.reply({
                content: 'Aquí tienes el archivo que solicitaste:',
                files: [{
                    attachment: fileResponse.data,
                    name: fileObj.filename
                }]
            }).catch(console.error);;
            //borramos el archivo del store de openai
            const fileObjDel = await openai.files.del(fileId);
            if (fileObjDel.deleted)
                console.log("Archivo borrado del store de openai");
        }


    } catch (error) {
        console.error("Error in SendMessageToAssistant: ", error);
        message.reply({ content: "Hubo un error al procesar tu mensaje. Por favor, intenta nuevamente más tarde." }).catch(console.error);
    }
}

// This event will run every time a message is received
client.on('messageCreate', async message => {
    try {
        message.channel.sendTyping();
        //Evitando los msgs del bot o contenido vacio 
        //Determinamos si recibimos un archivo o un mensaje de discord
        if (message.attachments.size > 0 && !message.author.bot)
            await UploadAssistantFile(message);
        else if (message.author.bot || !message.content || message.content === '') return; //Ignore bot messages
        else
            await SendMessageToAssistant(message);
        await message.channel.send('Prompt procesado!').catch(console.error);
    } catch (error) {
        console.error("Error processing message: ", error);
    }
});

// Función que envuelve openai.files.retrieve en una promesa
function retrieveFileAsPromise(fileId) {
    return new Promise((resolve, reject) => {
        openai.files.retrieve(fileId)
            .then(file => {
                resolve(file);
            })
            .catch(error => {
                reject(error);
            });
    });
}

// Ejemplo de uso con async/await
async function getFileInfo(fileId) {
    try {
        const file = await retrieveFileAsPromise(fileId);
        //console.log('Información del archivo:', file);
        return file;
    } catch (error) {
        console.error('Error al recuperar el archivo:', error);
        throw error;
    }
}

/**
 * Crea una promesa que se resuelve después de un tiempo especificado.
 * @param {number} ms - El número de milisegundos a esperar.
 * @returns {Promise} Una promesa que se resuelve después del tiempo especificado.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;
    let lista = '';
    if (commandName === 'listarchivos')
        try {
            // Recupera los datos del asistente
            const myAssistant = await openai.beta.assistants.retrieve(process.env.ASSISTANT_ID); 
            // Lista los archivos del recurso tool_resources
            if (myAssistant.tool_resources.code_interpreter && myAssistant.tool_resources.code_interpreter.file_ids.length > 0) {
                myAssistant.tool_resources.code_interpreter.file_ids.forEach(id_archivo => {
                    getFileInfo(id_archivo)
                        .then(file => {
                            // Hacer algo con la información del archivo
                            console.log('Nombre del archivo:', file.filename);
                            //console.log('Tamaño del archivo:', file.bytes, 'bytes');
                            //console.log('Fecha de creación:', new Date(file.created_at * 1000).toLocaleString());
                            lista += `${file.filename} ## ${id_archivo}\n`;
                        })
                        .catch(error => {
                            console.error('Error en la operación:', error);
                        });
                })
                await delay(1000);
                await interaction.reply(lista);
            }
            else
                await interaction.reply('Asistente no tiene archivos');
        } catch (error) {
            console.error('Error al recuperar los datos del asistente:', error);
        }
    else if (commandName === 'borrarchivo') {
        const nombrearchivo = interaction.options.getString('id');
        try {
            await openai.files.del(nombrearchivo.trim());
            await interaction.reply('Archivo borrado');
        } catch (error) {
            console.error(error);
            await interaction.reply('Archivo no encontrado');
        }
    }
});

client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    readyClient.commands = new Collection();
    const commands = [
        new SlashCommandBuilder().setName('listarchivos').setDescription('Lista archivos enviados al asistente'),
        new SlashCommandBuilder().setName('borrarchivo').setDescription('Borra archivo del asistente').addStringOption(option => option.setName('id').setDescription('Formato file-...').setRequired(true))
    ].map(command => command.toJSON());
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    (async () => {
        try {
            console.log('Started refreshing application (/) commands.');

            await rest.put(
                Routes.applicationCommands(readyClient.user.id),
                { body: commands },
            );

            console.log('Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error(error);
        }
    })();
});

// When discord bot has started up
client.once('ready', () => {
    console.log('Bot is ready! ' + BOTVERSION);
});


// Authenticate Discord
client.login(process.env.DISCORD_TOKEN).catch(console.error);
