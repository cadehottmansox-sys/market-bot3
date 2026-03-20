const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      itemName: null, itemUrl: null, imageUrl: null,
      imageAttachment: null, status: 'idle',
      dashboardMessageId: null, dashboardChannelId: null, awaitingPhoto: false,
    });
  }
  return sessions.get(userId);
}

function clearSession(userId) {
  sessions.set(userId, {
    itemName: null, itemUrl: null, imageUrl: null,
    imageAttachment: null, status: 'idle',
    dashboardMessageId: null, dashboardChannelId: null, awaitingPhoto: false,
  });
}

function buildDashboard(session) {
  const lines = [];
  const hasItem = session.itemName || session.itemUrl;
  if (hasItem) {
    lines.push('\u{1F3F7}\uFE0F **Slot 1 \u2014 Item**');
    lines.push('\u2705 ' + (session.itemName || session.itemUrl));
  } else {
    lines.push('\u{1F3F7}\uFE0F **Slot 1 \u2014 Item Name or Link**');
    lines.push('\u2B1C Nothing entered yet');
  }
  lines.push('');
  if (session.imageUrl || session.imageAttachment) {
    lines.push('\u{1F4F8} **Slot 2 \u2014 Item Photo** *(optional)*');
    lines.push('\u2705 Photo uploaded');
  } else {
    lines.push('\u{1F4F8} **Slot 2 \u2014 Item Photo** *(optional)*');
    lines.push('\u2B1C Upload a photo to improve accuracy');
  }
  lines.push('');
  if (session.status === 'searching') lines.push('\u23F3 Searching eBay & Depop...');
  else if (session.status === 'done') lines.push('\u2705 Analysis complete \u2014 results posted below');
  else if (hasItem) lines.push('Ready! Hit **\u{1F50D} Find Comps** to search recent sales.');
  else lines.push('Enter an item name, link, or photo to get started.');

  return new EmbedBuilder()
    .setTitle('\u{1F3F7}\uFE0F ResellBot Dashboard')
    .setDescription(lines.join('\n'))
    .setColor(session.status === 'done' ? 0x00c851 : session.status === 'searching' ? 0xffaa00 : 0x5865f2)
    .setFooter({ text: 'ResellBot \u2022 eBay & Depop Comp Finder' });
}

function buildButtons(session) {
  const hasItem = session.itemName || session.itemUrl;
  const isSearching = session.status === 'searching';
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_enter_item')
      .setLabel(hasItem ? 'Edit Item' : 'Enter Item Name / Link')
      .setStyle(hasItem ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(isSearching),
    new ButtonBuilder().setCustomId('rb_upload_photo')
      .setLabel(session.imageUrl || session.imageAttachment ? 'Re-upload Photo' : 'Upload Photo (optional)')
      .setStyle(ButtonStyle.Primary).setDisabled(isSearching),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_find_comps').setLabel('Find Comps')
      .setStyle(ButtonStyle.Danger).setDisabled(!hasItem || isSearching),
    new ButtonBuilder().setCustomId('rb_full_listing').setLabel('Generate Full Listing')
      .setStyle(ButtonStyle.Success).setDisabled(!hasItem || isSearching),
    new ButtonBuilder().setCustomId('rb_clear').setLabel('Clear')
      .setStyle(ButtonStyle.Secondary).setDisabled(isSearching),
  );
  return [row1, row2];
}

async function sendDashboard(channel, userId) {
  const session = getSession(userId);
  const msg = await channel.send({ embeds: [buildDashboard(session)], components: buildButtons(session) });
  session.dashboardMessageId = msg.id;
  session.dashboardChannelId = channel.id;
  return msg;
}

async function safeUpdate(interaction, session) {
  try {
    await interaction.editReply({ embeds: [buildDashboard(session)], components: buildButtons(session) });
  } catch (e) {
    console.warn('safeUpdate failed:', e.message);
  }
}

async function handleInteraction(interaction, { anthropic, scrapeEbay, scrapeDepop, generateRecommendation, sendResults }) {
  const userId = interaction.user.id;
  const session = getSession(userId);

  if (interaction.isButton() && interaction.customId === 'rb_enter_item') {
    const modal = new ModalBuilder().setCustomId('rb_modal_item').setTitle('Enter Item Details');
    const input = new TextInputBuilder().setCustomId('item_input')
      .setLabel('Item name, eBay/Depop link, or search query')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Nike Dunk Low Panda sz10')
      .setRequired(true).setValue(session.itemName || session.itemUrl || '');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'rb_modal_item') {
    const raw = interaction.fields.fields.get('item_input')?.value?.trim() || '';
    if (raw.startsWith('http')) { session.itemUrl = raw; session.itemName = null; }
    else { session.itemName = raw; session.itemUrl = null; }
    session.status = 'idle';
    try {
      await interaction.update({ embeds: [buildDashboard(session)], components: buildButtons(session) });
    } catch (e) {
      console.error('modal update err:', e.message);
      try { await interaction.reply({ embeds: [buildDashboard(session)], components: buildButtons(session) }); } catch (_) {}
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === 'rb_upload_photo') {
    session.awaitingPhoto = true;
    await interaction.reply({ content: 'Send your photo now as a message in this channel.', ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'rb_clear') {
    clearSession(userId);
    const s = getSession(userId);
    try { await interaction.update({ embeds: [buildDashboard(s)], components: buildButtons(s) }); } catch (e) { console.warn(e.message); }
    return;
  }

  if (interaction.isButton() && (interaction.customId === 'rb_find_comps' || interaction.customId === 'rb_full_listing')) {
    const isFullListing = interaction.customId === 'rb_full_listing';
    session.status = 'searching';
    try { await interaction.update({ embeds: [buildDashboard(session)], components: buildButtons(session) }); } catch (e) { console.warn(e.message); }

    try {
      let resolvedQuery = session.itemName || session.itemUrl || '';
      if ((session.imageUrl || session.imageAttachment) && !session.itemName) {
        resolvedQuery = await identifyFromImage(anthropic, session.imageUrl || session.imageAttachment);
        session.itemName = resolvedQuery;
      }
      const [ebayRes, depopRes] = await Promise.allSettled([scrapeEbay(resolvedQuery), scrapeDepop(resolvedQuery)]);
      const ebay = ebayRes.status === 'fulfilled' ? ebayRes.value : [];
      const depop = depopRes.status === 'fulfilled' ? depopRes.value : [];
      const rec = await generateRecommendation(anthropic, resolvedQuery, ebay, depop, session.imageUrl || session.imageAttachment, isFullListing);
      session.status = 'done';
      // Update the dashboard embed silently — don't crash if it fails
      try { await interaction.editReply({ embeds: [buildDashboard(session)], components: buildButtons(session) }); } catch (_) {}
      await sendResults(interaction.channel, rec, ebay, depop, resolvedQuery, session.imageUrl || session.imageAttachment);
    } catch (err) {
      console.error('Search error:', err.message);
      session.status = 'idle';
      try { await interaction.editReply({ embeds: [buildDashboard(session)], components: buildButtons(session) }); } catch (_) {}
      try { await interaction.followUp({ content: 'Error: ' + err.message, ephemeral: true }); } catch (_) {}
    }
  }
}

async function identifyFromImage(anthropic, imageUrl) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 150,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'url', url: imageUrl } },
      { type: 'text', text: 'Identify this for resale. Return ONLY a short eBay search query (brand + model + key details, max 8 words).' },
    ]}],
  });
  return r.content[0].text.trim();
}

module.exports = { getSession, sendDashboard, handleInteraction, buildDashboard, buildButtons };
