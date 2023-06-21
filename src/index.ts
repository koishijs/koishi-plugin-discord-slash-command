import { Argv, Bot, Command, Context, Logger, segment, I18n, Session, Schema, Next } from "koishi";
import DiscordBot, { adaptMessage, adaptSession, Discord, DiscordMessenger } from '@koishijs/plugin-adapter-discord'

declare module 'koishi' {
  namespace Command {
    interface Config {
      slash?: boolean
    }
  }
}

export const name = 'discord-slash-command'

export interface Config { }

export const Config: Schema<Config> = Schema.object({})

const types = {
  text: Discord.ApplicationCommand.OptionType.STRING,
  string: Discord.ApplicationCommand.OptionType.STRING, // _arguments type会出现
  boolean: Discord.ApplicationCommand.OptionType.BOOLEAN,
  number: Discord.ApplicationCommand.OptionType.NUMBER,
  integer: Discord.ApplicationCommand.OptionType.INTEGER,
  posint: Discord.ApplicationCommand.OptionType.INTEGER, // 加个 min_value
  user: Discord.ApplicationCommand.OptionType.STRING,
  channel: Discord.ApplicationCommand.OptionType.STRING,
  guild: Discord.ApplicationCommand.OptionType.STRING
}


export function apply(ctx: Context) {
  const logger = new Logger('dc-command')

  // ctx.console.addListener('command/update', (name: string, config: CommandState) => {
  //   console.log(name, config)
  //   let list = ctx.$commander._commandList.filter(cmd => cmd.config.discordSlash)
  //   console.log(list)
  //   let bots = ctx.bots.filter(v => v.platform === 'discord' && v.status === 'online' && v.socket)
  //   bots.forEach(bot => updateBotCommands(bot as unknown as DiscordBot))
  // })

  ctx.schema.extend('command', Schema.object({
    slash: Schema.boolean().description('非立即生效, 设置此项后重启 discord-slash-command 插件')
  }))

  function generateLang(key: I18n.Node): Record<string, string> {
    return Object.keys(ctx.i18n._data).filter(lang => lang).reduce((obj, lang) => {
      let dcLang = lang
      if (lang === 'zh-tw') dcLang = 'zh-TW'
      if (lang === 'zh') dcLang = 'zh-CN'
      if (lang === 'en') dcLang = 'en-US'
      if (ctx.i18n._data[lang][key.toString()]) {
        obj[dcLang] = ctx.i18n._data[lang][key.toString()]
      }
      return obj
    }, {})
  }

  function generateCommandOptions(cmd: Command): Discord.ApplicationCommand.Option[] {
    let list: Discord.ApplicationCommand.Option[] = []
    const realChildren = cmd.children.filter(child =>
      child.name.startsWith(cmd.name))
    /** eg: test/abc.zzz 不筛选出 abc.zzz */
    if (realChildren.length) {
      list.push(...realChildren.map(child => ({
        name: child.name.slice(cmd.name.length + 1),
        type: child.children.length ? Discord.ApplicationCommand.OptionType.SUB_COMMAND_GROUP : Discord.ApplicationCommand.OptionType.SUB_COMMAND,
        options: generateCommandOptions(child),
        description: ctx.i18n._data[''][`commands.${child.name}.description`]?.toString() || child.displayName,
      })))
    } else {
      for (const arg of cmd._arguments) {
        list.push({
          name: arg.name.toLocaleLowerCase(),
          description: arg.type?.toString() || arg.name,
          // @ts-ignore
          type: types[arg.type] ?? types.text,
          required: arg.required ?? false,
        })
      }
      for (const key in cmd._options) {
        const option = cmd._options[key]
        list.push({
          name: key.toLocaleLowerCase(), // discord limit
          description: ctx.i18n._data[''][`commands.${cmd.name}.options.${key}`]?.toString() || key,
          type: types[option.type as unknown as string] ?? types.text,
          required: option.required ?? false,
          // @ts-ignore
          description_localizations: generateLang(`commands.${cmd.name}.options.${key}`),
          min_value: option.type === 'posint' ? 1 : undefined,
        })
      }
    }
    list = list.sort((a, b) => +b.required - +a.required)
    return list
  }

  function adaptSlashInteraction(session: Session, data: Discord.InteractionData.ApplicationCommand): Session<never, never> {
    let options = data.options || []
    let realOptions: Discord.ApplicationCommandInteractionDataOption[] = options
    let cmd = ctx.$commander._commands.get(data.name)

    let cmdName = data.name

    for (let i = 1; i <= 2; i++) {
      const subOption = realOptions.find(v => v.type === Discord.ApplicationCommand.OptionType.SUB_COMMAND || v.type === Discord.ApplicationCommand.OptionType.SUB_COMMAND_GROUP)
      if (subOption) {
        // use the subcommand
        cmdName += '.' + subOption.name
        realOptions = subOption.options
        cmd = cmd.children.find(v => v.name === cmdName)
      } else {
        break;
      }
    }

    logger.debug('options input %o', realOptions)
    let newOptions = {}
    for (const cmdOptKey in cmd._options) {
      const discordInput = realOptions.find(v => v.name.toLocaleLowerCase() === cmdOptKey.toLocaleLowerCase())
      if (discordInput) {
        // input
        if (discordInput.type === Discord.ApplicationCommand.OptionType.CHANNEL) {
          newOptions[cmdOptKey] = `#discord:${discordInput.value}` // not used
        } else if (discordInput.type === Discord.ApplicationCommand.OptionType.USER) {
          newOptions[cmdOptKey] = `@discord:${discordInput.value}` // not used
        }
        else {
          newOptions[cmdOptKey] = discordInput.value // input
        }
      }
    }
    let newArgs = []
    for (const args of cmd._arguments) {
      const discordInput = realOptions.find(v => v.name.toLocaleLowerCase() === args.name.toLocaleLowerCase())
      if (discordInput) {
        // input
        if (Object.values(types).includes(discordInput.type)) {
          newArgs.push(discordInput.value)
        }
      }
    }

    const argv = {
      name: cmdName,
      args: newArgs,
      //command: key,
      options: newOptions,
      session: session
    } as Argv
    session.argv = argv

    logger.debug('argv %o', argv)
    return session
  }

  // const onInteractionCreate

  async function updateBotCommands(bot: DiscordBot) {
    let list = ctx.$commander._commandList.filter(cmd => cmd.config.slash)
    const commands = await bot.internal.getGlobalApplicationCommands(bot.selfId)

    async function upsertCommand(cmd: Command) {
      const existing = commands.find(v => v.name === cmd.name)
      const options = []

      options.push(...generateCommandOptions(cmd))

      let data = {
        name: cmd.name.toLocaleLowerCase(),
        type: 1,
        description: ctx.i18n._data[''][`commands.${cmd.name}.description`] || cmd.displayName,
        options: options
      } as Discord.ApplicationCommand.Option
      logger.debug(JSON.stringify(data))
      try {
        if (!existing) {
          await bot.http.post('/applications/' + bot.selfId + '/commands', data)
        } else if (JSON.stringify(data) !== JSON.stringify(existing)) {
          await bot.http.patch('/applications/' + bot.selfId + '/commands/' + existing.id, data)
        } else {
          logger.info('already kept update %s', JSON.stringify(data))
        }
      } catch (e) {
        logger.error('remote: %s', JSON.stringify(e?.response?.data))
      }
    }


    for (const cmd of list) {
      logger.info('upsert command: %s', cmd.name)
      await upsertCommand(cmd)
    }
    for (const onlineCmd of commands) {
      if (!list.map(cmd => cmd.name).includes(onlineCmd.name)) {
        logger.debug('deleting command %o', onlineCmd)
        await bot.http.delete('/applications/' + bot.selfId + '/commands/' + onlineCmd.id)
      }
    }
  }

  let listeners: Record<string, boolean> = {}

  const init = async (bot: DiscordBot) => {
    if (listeners[bot.selfId]) return;

    listeners[bot.selfId] = true
    logger.info('init socket %s', bot.selfId)

    await updateBotCommands(bot)
    bot.socket.addEventListener('message', async (data) => {
      const parsed = JSON.parse(data.data.toString()) as Discord.GatewayPayload
      if (parsed.op === Discord.GatewayOpcode.DISPATCH) {
        if (parsed.t === 'INTERACTION_CREATE') {
          await bot.http.post(`/interactions/${parsed.d.id}/${parsed.d.token}/callback`, { type: Discord.InteractionCallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE })
          let session = bot.session()
          session.platform = 'discord'
          session.type = "message"
          session.subtype = parsed.d.guild_id ? 'group' : 'private'
          session.channelId = parsed.d.channel_id
          session.guildId = parsed.d.guild_id
          session.userId = parsed.d.member.user.id
          session.messageId = parsed.d.id
          // @ts-ignore
          session.discord = parsed.d
          session.content = ""

          logger.debug('discord input %s', JSON.stringify(parsed.d.data))
          // @ts-ignore
          session = adaptSlashInteraction(session, parsed.d.data)

          // console.log(`/webhooks/${parsed.d.application_id}/${parsed.d.token}`)
          // 如果已发 ACK, 直接 followUp 也是替换原来的
          const editUrl = `/webhooks/${parsed.d.application_id}/${parsed.d.token}/messages/@original`
          const followUpUrl = `/webhooks/${parsed.d.application_id}/${parsed.d.token}`
          let send = new DiscordMessenger(bot, parsed.d.channel_id)

          send.post = async (data?: any, headers?: any) => {
            try {
              logger.debug('follow up url: %s', followUpUrl)
              const result = await bot.http.post<Discord.Message>(followUpUrl, data, { headers })
            } catch (error) {
              console.log(error)
            }
          }

          // @ts-ignore
          session.send = async (content) => {
            let stack = new Error()
            // console.trace(this, session.scope)
            logger.debug(stack)
            if (stack.stack.includes("session.ts:406:18")) {
              // if (session.scope.startsWith("commands.") && session.scope.endsWith(".messages")) {
              // command response
              // logger.info('session.send %o', content)
              let sent = await send.send(content.toString())
            } else {
              await bot.sendMessage(session.channelId, content)
            }
          }
          let data = await session.execute(session.argv)
          logger.info('execute')
        }
      }
    })
  }

  ctx.on('ready', () => {
    logger.info('ready')
    let bots = ctx.bots.filter(v => v.platform === 'discord' && v.status === 'online' && v.socket)
    bots.forEach(bot => init(bot as unknown as DiscordBot))
  })

  // write your plugin here
  ctx.on('bot-status-updated', async (bot) => {
    if (bot.platform === "discord" && bot.status === 'reconnect') {
      listeners[bot.selfId] = false
    }
    if (bot.platform !== "discord" || bot.status !== "online" || !bot.socket) return;
    init(bot as unknown as DiscordBot)
  })
}
