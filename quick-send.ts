import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN!;

const GIF_URL = 'https://cdn.discordapp.com/attachments/1409616969770205296/1466903491795488810/asa_3_1.gif?ex=6a2dc756&is=6a2c75d6&hm=94ffb671b92a4fef04c6606613ae41c7e7131b6912cdd8cb714dbf268814684e&';

const LB = [
  { id: '1509210175406604328', min: 1, max: 10 },
  { id: '1509210720011554987', min: 11, max: 20 },
  { id: '1509210811766276276', min: 21, max: 30 },
];
const TICKETS = '1509211671464513547';

function vacantValue(): string {
  return 'ID: —\n*No player registered*\n<< | .vacant. | >>\nRegion: —\nStage: —\nStatus: Empty\nwins: 0 losses: 0';
}

function vacantName(rank: number): string {
  return `**#${rank}**  Vacant`;
}

function buildRankEmbeds(minRank: number, maxRank: number): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];

  for (let rank = minRank; rank <= maxRank; rank++) {
    const embed = new EmbedBuilder()
      .setColor(0x1a1a2e)
      .addFields({ name: vacantName(rank), value: vacantValue(), inline: false })
      .setImage(GIF_URL);
    embeds.push(embed);
  }

  return embeds;
}

async function run() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(TOKEN);
  await new Promise((resolve) => {
    if (client.isReady()) return resolve(null);
    client.once('clientReady', () => resolve(null));
  });
  console.log('Bot ready: ' + client.user!.tag);

  for (const lb of LB) {
    const ch = (await client.channels.fetch(lb.id)) as TextChannel;
    if (!ch) continue;

    const msgs = await ch.messages.fetch({ limit: 5 });
    const botMsg = msgs.find((m) => m.author.id === client.user!.id && m.embeds.length > 0);

    const embeds = buildRankEmbeds(lb.min, lb.max);

    if (botMsg) {
      await botMsg.edit({ embeds });
      console.log(`Edited "${lb.title}" in #${ch.name}`);
    } else {
      await ch.send({ embeds });
      console.log(`Sent "${lb.title}" in #${ch.name}`);
    }
  }

  // Ticket panel
  const tch = (await client.channels.fetch(TICKETS)) as TextChannel;
  if (tch) {
    const tMsgs = await tch.messages.fetch({ limit: 5 });
    const tBot = tMsgs.find((m) => m.author.id === client.user!.id && m.embeds.length > 0);

    const embed = new EmbedBuilder()
      .setTitle('🎫 Challenge Tickets')
      .setColor(0x5865F2)
      .setDescription(
        '**Welcome to the TSBER Challenge System!**\n\n' +
        '**Create** — Register your profile with Roblox verification to join the leaderboard.\n' +
        '**Challenge** — Select an eligible opponent to challenge and start a match ticket.\n\n' +
        'Click a button below to get started.',
      )
      .setFooter({ text: 'Persistent buttons • Work even after bot restarts' })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('btn_create_profile').setLabel('Create').setStyle(ButtonStyle.Success).setEmoji('📝'),
      new ButtonBuilder().setCustomId('btn_challenge').setLabel('Challenge').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
    );

    if (tBot) {
      await tBot.edit({ embeds: [embed], components: [row] });
    } else {
      await tch.send({ embeds: [embed], components: [row] });
    }
    console.log('Done: ticket panel');
  }

  console.log('All done! Check Discord.');
  client.destroy();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
