// v2.1
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require('discord.js');


// Session state per user
const sessions = new Map();


function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      itemName: null,
      itemUrl: null,
      imageUrl: null,
      imageAttachment: null,
      status: 'idle', // idle | ready | searching | done
    });
  }
  return sessions.get(userId);
}


function clearSession(userId) {
  sessions.set(userId, {
    itemName: null,
    itemUrl: null,
    imageUrl: null,
    imageAttachment: null,
    status: 'idle',
  });
}
