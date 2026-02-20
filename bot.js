require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const STORE_URL  = process.env.STORE_URL  || 'http://localhost:3000';
const BOT_SECRET = process.env.BOT_SECRET || '';
const GUILD_ID   = process.env.DISCORD_GUILD_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const ADMIN_IDS = {
  '1429171703879307277': 'owner',
  '1472967180747280562': 'owner',
  '1474153224654028850': 'co-owner',
  '1472967373198721137': 'admin',
};

// ─── COLORS ──────────────────────────────────────────────────────────────────
const COLORS = {
  blue:      0x2563eb,
  red:       0xef4444,
  green:     0x22c55e,
  yellow:    0xeab308,
  orange:    0xf97316,
  pink:      0xec4899,
  purple:    0xa855f7,
  black:     0x111111,
  white:     0xffffff,
  darkblue:  0x1e3a8a,
  default:   0x2563eb,
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function isAdmin(userId) { return !!ADMIN_IDS[userId]; }

async function storeAPI(method, path, body) {
  const res = await fetch(`${STORE_URL}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'x-bot-secret':  BOT_SECRET,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function statusEmoji(status) {
  const map = { pending:'⏳', processing:'⚙️', shipped:'🚚', delivered:'✅', cancelled:'❌' };
  return map[status] || '❓';
}

function starsDisplay(n) {
  return '⭐'.repeat(Math.max(1, Math.min(5, n)));
}

// ─── SLASH COMMANDS DEFINITION ────────────────────────────────────────────────
const commands = [
  // /orders — admin only
  new SlashCommandBuilder()
    .setName('orders')
    .setDescription('View recent orders (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // /order <id>
  new SlashCommandBuilder()
    .setName('order')
    .setDescription('Look up a specific order')
    .addStringOption(o => o.setName('id').setDescription('Order ID e.g. ORD-ABC123').setRequired(true)),

  // /track — anyone, see their own orders
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track your orders')
    .addStringOption(o => o.setName('orderid').setDescription('Order ID to track (optional — leave blank to see all your orders)').setRequired(false)),

  // /products — public
  new SlashCommandBuilder()
    .setName('products')
    .setDescription('Browse available products in the store'),

  // /stock — admin
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('View product stock levels (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // /vouch
  new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Leave a vouch for a purchase')
    .addUserOption(o => o.setName('user').setDescription('The user you are vouching for / who served you').setRequired(true))
    .addIntegerOption(o => o.setName('stars').setDescription('Rating 1-5 stars').setRequired(true).setMinValue(1).setMaxValue(5))
    .addStringOption(o => o.setName('reason').setDescription('What did you buy? How was the experience?').setRequired(true)),

  // /membership — admin only
  new SlashCommandBuilder()
    .setName('membership')
    .setDescription('Check a user\'s membership status (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('The user to check').setRequired(true)),

  // /memadd — admin only
  new SlashCommandBuilder()
    .setName('memadd')
    .setDescription('Grant membership to a user (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('User to give membership').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Optional note').setRequired(false)),

  // /memrevoke — admin only
  new SlashCommandBuilder()
    .setName('memrevoke')
    .setDescription('Revoke membership from a user (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('User to revoke').setRequired(true)),

  // /suggest
  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Suggest something for the shop')
    .addStringOption(o => o.setName('suggestion').setDescription('What would you like to see added?').setRequired(true)),
].map(c => c.toJSON());

// ─── REGISTER COMMANDS ────────────────────────────────────────────────────────
async function registerCommands() {
  if (!BOT_TOKEN || !GUILD_ID) {
    console.error('❌ Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID');
    return;
  }
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(
      (await rest.get(Routes.user())).id,
      GUILD_ID
    ), { body: commands });
    console.log(`✅ Registered ${commands.length} slash commands to guild ${GUILD_ID}`);
  } catch (err) {
    console.error('❌ Failed to register commands:', err.message);
  }
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('ready', async () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);
  await registerCommands();
});

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user } = interaction;

  try {
    // ── /orders ──────────────────────────────────────────────────────────────
    if (commandName === 'orders') {
      await interaction.deferReply({ ephemeral: true });
      const orders = await storeAPI('GET', '/api/bot/orders');
      if (!orders?.length) {
        return interaction.editReply('No orders found.');
      }
      const embed = new EmbedBuilder()
        .setTitle('📦 Recent Orders')
        .setColor(COLORS.blue)
        .setTimestamp();
      orders.slice(0, 8).forEach(o => {
        embed.addFields({
          name: `${statusEmoji(o.status)} ${o.id} — $${Number(o.total).toFixed(2)}`,
          value: `**${o.customer}** • ${o.status} • ${o.date}\n${o.items.map(i => `${i.name} ×${i.qty}`).join(', ')}`,
          inline: false,
        });
      });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /order <id> ───────────────────────────────────────────────────────────
    if (commandName === 'order') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getString('id').toUpperCase();
      const order = await storeAPI('GET', `/api/bot/order/${id}`);
      if (!order || order.error) {
        return interaction.editReply(`❌ Order \`${id}\` not found.`);
      }
      const embed = new EmbedBuilder()
        .setTitle(`📦 Order ${order.id}`)
        .setColor(COLORS[order.status === 'delivered' ? 'green' : order.status === 'cancelled' ? 'red' : 'blue'])
        .addFields(
          { name: 'Customer',  value: order.customer,                     inline: true },
          { name: 'Status',    value: `${statusEmoji(order.status)} ${order.status}`, inline: true },
          { name: 'Total',     value: `$${Number(order.total).toFixed(2)}`, inline: true },
          { name: 'Date',      value: order.date,                         inline: true },
          { name: 'Type',      value: order.type,                         inline: true },
          { name: 'Email',     value: order.email || 'N/A',               inline: true },
          { name: 'Items',     value: order.items.map(i => `• ${i.name}${i.variant ? ` (${i.variant})` : ''} ×${i.qty} — $${i.price}`).join('\n') },
        )
        .setTimestamp();
      if (order.notes) embed.addFields({ name: 'Notes', value: order.notes });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /track ────────────────────────────────────────────────────────────────
    if (commandName === 'track') {
      await interaction.deferReply({ ephemeral: true });
      const specificId = interaction.options.getString('orderid');

      if (specificId) {
        const order = await storeAPI('GET', `/api/bot/order/${specificId.toUpperCase()}`);
        if (!order || order.error) {
          return interaction.editReply(`❌ Order \`${specificId.toUpperCase()}\` not found.`);
        }
        const embed = new EmbedBuilder()
          .setTitle(`🔍 Tracking: ${order.id}`)
          .setColor(order.status === 'delivered' ? COLORS.green : COLORS.blue)
          .setDescription(`**Status: ${statusEmoji(order.status)} ${order.status.toUpperCase()}**`)
          .addFields(
            { name: 'Items',   value: order.items.map(i => `• ${i.name}${i.variant ? ` (${i.variant})` : ''}`).join('\n') },
            { name: 'Total',   value: `$${Number(order.total).toFixed(2)}`, inline: true },
            { name: 'Ordered', value: order.date, inline: true },
          )
          .setFooter({ text: 'Need help? Open a ticket or DM an admin.' })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      // No ID — show all orders for this Discord user
      const allOrders = await storeAPI('GET', '/api/bot/orders');
      const myOrders = (allOrders || []).filter(o => o.discordId === user.id);
      if (!myOrders.length) {
        return interaction.editReply('You have no orders on record. If you placed an order, make sure you were logged in via Discord.');
      }
      const embed = new EmbedBuilder()
        .setTitle('📦 Your Orders')
        .setColor(COLORS.blue)
        .setTimestamp();
      myOrders.slice(0, 6).forEach(o => {
        embed.addFields({
          name: `${statusEmoji(o.status)} ${o.id}`,
          value: `${o.items.map(i => i.name).join(', ')} — **$${Number(o.total).toFixed(2)}** — ${o.status}`,
          inline: false,
        });
      });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /products ─────────────────────────────────────────────────────────────
    if (commandName === 'products') {
      await interaction.deferReply({ ephemeral: false });
      const products = await fetch(`${STORE_URL}/api/products`).then(r => r.json());
      if (!products?.length) return interaction.editReply('No products available right now.');
      const available = products.filter(p => !p.tags?.includes('COMING SOON'));
      const embed = new EmbedBuilder()
        .setTitle('🛍️ N.M.L ShopWave — Products')
        .setColor(COLORS.blue)
        .setURL(STORE_URL)
        .setTimestamp();
      available.slice(0, 8).forEach(p => {
        const price = p.price != null ? `$${p.price.toFixed(2)}${p.originalPrice ? ` ~~$${p.originalPrice.toFixed(2)}~~` : ''}` : 'TBA';
        const tags = (p.tags || []).map(t => `\`${t}\``).join(' ');
        embed.addFields({
          name: p.name,
          value: `${price} • ${p.type} ${tags ? `• ${tags}` : ''}\n${p.description?.slice(0, 80)}…`,
          inline: false,
        });
      });
      embed.setFooter({ text: `${available.length} products available • ${STORE_URL}` });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /stock ────────────────────────────────────────────────────────────────
    if (commandName === 'stock') {
      await interaction.deferReply({ ephemeral: true });
      const products = await fetch(`${STORE_URL}/api/products`).then(r => r.json());
      const embed = new EmbedBuilder()
        .setTitle('📊 Stock Levels')
        .setColor(COLORS.blue)
        .setTimestamp();
      products.forEach(p => {
        const stock = p.stock === null ? '∞ Unlimited' : p.stock === 0 ? '❌ Out of stock' : p.stock <= 5 ? `⚠️ ${p.stock} left` : `✅ ${p.stock}`;
        embed.addFields({ name: p.name, value: stock, inline: true });
      });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /vouch ────────────────────────────────────────────────────────────────
    if (commandName === 'vouch') {
      // Delete the slash command invocation immediately
      await interaction.deferReply();
      await interaction.deleteReply().catch(() => {});

      const targetUser = interaction.options.getUser('user');
      const stars      = interaction.options.getInteger('stars');
      const reason     = interaction.options.getString('reason');

      // Get vouch channel from store settings
      const settings = await fetch(`${STORE_URL}/api/settings`, {
        headers: { 'x-bot-secret': BOT_SECRET },
      }).then(r => r.json()).catch(() => ({}));

      const vouchChannelId = settings.vouchChannelId || process.env.VOUCH_CHANNEL_ID;
      if (!vouchChannelId) {
        return; // Silently fail if not configured — don't expose error to channel
      }

      const channel = client.channels.cache.get(vouchChannelId);
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setTitle('🔥 New VOUCH! 🔥')
        .setColor(COLORS.yellow)
        .addFields(
          { name: '👤 From',    value: `<@${user.id}> (${user.username})`, inline: true },
          { name: '🎯 For',     value: `<@${targetUser.id}> (${targetUser.username})`, inline: true },
          { name: '⭐ Rating',  value: starsDisplay(stars) + ` (${stars}/5)`, inline: true },
          { name: '💬 Review',  value: reason },
        )
        .setThumbnail(user.displayAvatarURL())
        .setTimestamp()
        .setFooter({ text: 'N.M.L ShopWave' });

      // @everyone ping + embed
      await channel.send({ content: '@everyone', embeds: [embed] });

      // Save to store
      await storeAPI('POST', '/api/vouches', {
        fromId: user.id,
        fromUsername: user.username,
        forId: targetUser.id,
        forUsername: targetUser.username,
        stars,
        reason,
      });
    }

    // ── /membership ───────────────────────────────────────────────────────────
    if (commandName === 'membership') {
      await interaction.deferReply({ ephemeral: true });
      const targetUser = interaction.options.getUser('user');
      const m = await storeAPI('GET', `/api/bot/membership/${targetUser.id}`);
      if (!m) {
        return interaction.editReply(`❌ **${targetUser.username}** does not have a membership.`);
      }
      const embed = new EmbedBuilder()
        .setTitle('💎 Membership Info')
        .setColor(COLORS.purple)
        .addFields(
          { name: 'User',     value: `<@${m.discordId}> (${m.username})`, inline: true },
          { name: 'Theme',    value: m.theme || 'default',                inline: true },
          { name: 'Added',    value: m.addedAt?.split('T')[0] || 'N/A',   inline: true },
          { name: 'Added by', value: m.addedBy || 'N/A',                  inline: true },
        )
        .setTimestamp();
      if (m.note) embed.addFields({ name: 'Note', value: m.note });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /memadd ───────────────────────────────────────────────────────────────
    if (commandName === 'memadd') {
      await interaction.deferReply({ ephemeral: true });
      const targetUser = interaction.options.getUser('user');
      const note = interaction.options.getString('note') || '';
      const result = await storeAPI('POST', '/api/bot/membership/add', {
        discordId: targetUser.id,
        username:  targetUser.username,
        addedBy:   user.username,
        note,
      });
      if (result.error === 'Already has membership') {
        return interaction.editReply(`⚠️ **${targetUser.username}** already has a membership.`);
      }
      const embed = new EmbedBuilder()
        .setTitle('💎 Membership Granted')
        .setColor(COLORS.green)
        .setDescription(`<@${targetUser.id}> now has a membership!`)
        .addFields(
          { name: 'Added by', value: user.username, inline: true },
          { name: 'Theme',    value: 'default (they can change it in the store)', inline: false },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /memrevoke ────────────────────────────────────────────────────────────
    if (commandName === 'memrevoke') {
      await interaction.deferReply({ ephemeral: true });
      const targetUser = interaction.options.getUser('user');
      const result = await storeAPI('POST', '/api/bot/membership/revoke', {
        discordId: targetUser.id,
      });
      if (result.error) {
        return interaction.editReply(`❌ **${targetUser.username}** does not have a membership.`);
      }
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('❌ Membership Revoked')
          .setColor(COLORS.red)
          .setDescription(`Membership removed from <@${targetUser.id}> (${targetUser.username}).`)
          .setTimestamp()
        ]
      });
    }

    // ── /suggest ──────────────────────────────────────────────────────────────
    if (commandName === 'suggest') {
      await interaction.deferReply();
      await interaction.deleteReply().catch(() => {});

      const suggestion = interaction.options.getString('suggestion');

      const settings = await fetch(`${STORE_URL}/api/settings`, {
        headers: { 'x-bot-secret': BOT_SECRET },
      }).then(r => r.json()).catch(() => ({}));

      const suggestionChannelId = settings.suggestionChannelId || process.env.SUGGESTION_CHANNEL_ID;
      if (!suggestionChannelId) return;

      const channel = client.channels.cache.get(suggestionChannelId);
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setTitle('💡 New Shop Suggestion')
        .setColor(COLORS.purple)
        .setDescription(suggestion)
        .addFields({ name: 'From', value: `${user.username}`, inline: true })
        .setThumbnail(user.displayAvatarURL())
        .setTimestamp()
        .setFooter({ text: 'N.M.L ShopWave Suggestions' });

      const msg = await channel.send({ embeds: [embed] });
      // Add vote reactions
      await msg.react('👍');
      await msg.react('👎');

      // Save to store
      await storeAPI('POST', '/api/suggestions', {
        discordId: user.id,
        username:  user.username,
        text:      suggestion,
        messageId: msg.id,
      });
    }

  } catch (err) {
    console.error(`❌ Error in /${commandName}:`, err.message);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Something went wrong. Please try again.');
      }
    } catch {}
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN not set. Add it to your .env file.');
  process.exit(1);
}
client.login(BOT_TOKEN);
