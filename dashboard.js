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

// ─── Build the main dashboard embed + buttons ───────────────────────────────

function buildDashboard(session) {
  const lines = [];

  // Slot 1 — Item Input
  const hasItem = session.itemName || session.itemUrl;
  if (hasItem) {
    lines.push(`🏷️ **Slot 1 — Item**`);
    lines.push(`✅ ${session.itemName || session.itemUrl}`);
  } else {
    lines.push(`🏷️ **Slot 1 — Item Name or Link**`);
    lines.push(`⬜ Nothing entered yet`);
  }

  lines.push('');

  // Slot 2 — Image
  if (session.imageUrl || session.imageAttachment) {
    lines.push(`📸 **Slot 2 — Item Photo** *(optional)*`);
    lines.push(`✅ Photo uploaded`);
  } else {
    lines.push(`📸 **Slot 2 — Item Photo** *(optional)*`);
    lines.push(`⬜ Upload a photo to improve accuracy`);
  }

  lines.push('');

  // Status
  if (session.status === 'searching') {
    lines.push(`⏳ Searching eBay & Depop for recent sales...`);
  } else if (session.status === 'done') {
    lines.push(`✅ Analysis complete — results posted below`);
  } else if (hasItem) {
    lines.push(`Ready! Hit **🔍 Find Comps** to search recent sales.`);
  } else {
    lines.push(`Enter an item name, link, or photo to get started.`);
  }

  const embed = new EmbedBuilder()
    .setTitle('🏷️ ResellBot Dashboard')
    .setDescription(lines.join('\n'))
    .setColor(session.status === 'done' ? 0x00c851 : session.status === 'searching' ? 0xffaa00 : 0x5865f2)
    .setFooter({ text: 'ResellBot • eBay & Depop Comp Finder' });

  return embed;
}

function buildButtons(session) {
  const hasItem = session.itemName || session.itemUrl;
  const isSearching = session.status === 'searching';

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rb_enter_item')
      .setLabel(hasItem ? '✏️ Edit Item' : '✏️ Enter Item Name / Link')
      .setStyle(hasItem ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(isSearching),

    new ButtonBuilder()
      .setCustomId('rb_upload_photo')
      .setLabel(session.imageUrl || session.imageAttachment ? '📸 Re-upload Photo' : '📸 Upload Photo (optional)')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isSearching),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rb_find_comps')
      .setLabel('🔍 Find Comps')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasItem || isSearching),

    new ButtonBuilder()
      .setCustomId('rb_full_listing')
      .setLabel('📝 Generate Full Listing')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasItem || isSearching),

    new ButtonBuilder()
      .setCustomId('rb_clear')
      .setLabel('🗑️ Clear')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSearching),
  );

  return [row1, row2];
}

// ─── Send / refresh dashboard ────────────────────────────────────────────────

async function sendDashboard(channel, userId) {
  const session = getSession(userId);
  const embed = buildDashboard(session);
  const components = buildButtons(session);

  const msg = await channel.send({ embeds: [embed], components });
  session.dashboardMessageId = msg.id;
  session.dashboardChannelId = channel.id;
  return msg;
}

async function refreshDashboard(interaction, userId) {
  const session = getSession(userId);
  const embed = buildDashboard(session);
  const components = buildButtons(session);

  await interaction.message.edit({ embeds: [embed], components });
}

// ─── Interaction handler ─────────────────────────────────────────────────────

async function handleInteraction(interaction, { anthropic, scrapeEbay, scrapeDepop, generateRecommendation, sendResults }) {
  const userId = interaction.user.id;
  const session = getSession(userId);

  // ── Enter item via modal ──────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'rb_enter_item') {
    const modal = new ModalBuilder()
      .setCustomId('rb_modal_item')
      .setTitle('Enter Item Details');

    const input = new TextInputBuilder()
      .setCustomId('item_input')
      .setLabel('Item name, eBay/Depop link, or search query')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Nike Dunk Low Panda sz10 — or paste a URL')
      .setRequired(true)
      .setValue(session.itemName || session.itemUrl || '');

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ── Modal submitted ───────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'rb_modal_item') {
const raw = interaction.fields.fields.get('item_input')?.value?.trim() || '';
    if (raw.startsWith('http')) {
      session.itemUrl = raw;
      session.itemName = null;
    } else {
      session.itemName = raw;
      session.itemUrl = null;
    }
    session.status = 'idle';
    await interaction.deferUpdate();
    await refreshDashboard(interaction, userId);
    return;
  }

  // ── Upload photo ──────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'rb_upload_photo') {
    await interaction.reply({
      content: '📸 **Send your photo now** as a message in this channel. The bot will grab it automatically.',
      ephemeral: true,
    });
    session.awaitingPhoto = true;
    return;
  }

  // ── Clear ─────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'rb_clear') {
    clearSession(userId);
    await interaction.deferUpdate();
    await refreshDashboard(interaction, userId);
    return;
  }

  // ── Find Comps ────────────────────────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId === 'rb_find_comps' || interaction.customId === 'rb_full_listing')) {
    const isFullListing = interaction.customId === 'rb_full_listing';
    session.status = 'searching';
    await interaction.deferUpdate();
    await refreshDashboard(interaction, userId);

    try {
      const query = session.itemName || session.itemUrl || '';
      let resolvedQuery = query;

      // If image provided + no name, use Claude Vision to identify
      if ((session.imageUrl || session.imageAttachment) && !session.itemName) {
        resolvedQuery = await identifyFromImage(anthropic, session.imageUrl || session.imageAttachment);
        session.itemName = resolvedQuery;
      }

      // Scrape eBay & Depop concurrently
      const [ebayListings, depopListings] = await Promise.allSettled([
        scrapeEbay(resolvedQuery),
        scrapeDepop(resolvedQuery),
      ]);

      const ebay = ebayListings.status === 'fulfilled' ? ebayListings.value : [];
      const depop = depopListings.status === 'fulfilled' ? depopListings.value : [];

      // Generate AI recommendation
      const rec = await generateRecommendation(
        anthropic,
        resolvedQuery,
        ebay,
        depop,
        session.imageUrl || session.imageAttachment,
        isFullListing
      );

      session.status = 'done';
      await refreshDashboard(interaction, userId);

      // Post results
      await sendResults(interaction.channel, rec, ebay, depop, resolvedQuery, session.imageUrl || session.imageAttachment);
    } catch (err) {
      console.error('Search error:', err);
      session.status = 'idle';
      await refreshDashboard(interaction, userId);
      await interaction.followUp({ content: `❌ Error: ${err.message}`, ephemeral: true });
    }
  }
}

async function identifyFromImage(anthropic, imageUrl) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: 'Identify this item for resale. Return ONLY a short search query (brand, model, key details, max 8 words) suitable for eBay/Depop search.' },
      ],
    }],
  });
  return response.content[0].text.trim();
}

module.exports = { getSession, sendDashboard, handleInteraction, buildDashboard, buildButtons };
