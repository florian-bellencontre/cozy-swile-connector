const {
  log,
  cozyClient,
  updateOrCreate,
  BaseKonnector,
  categorize
} = require('cozy-konnector-libs')
const moment = require('moment')
const { getSwileData } = require('./swile')
const { getToken } = require('./auth')
const doctypes = require('cozy-doctypes')
const { Document, BankAccount, BankTransaction, BankingReconciliator } =
  doctypes

Document.registerClient(cozyClient)

const minilog = require('@cozy/minilog')
minilog.suggest.allow('cozy-client', 'info')

const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })

class SwileConnector extends BaseKonnector {
  async fetch(fields) {
    if (process.env.NODE_ENV !== 'standalone') {
      cozyClient.new.login()
    }

    try {
      const token = await getToken(this, fields.login, fields.password)
      const [cards, ops] = await getSwileData(fields.login, token)

      log('info', 'Successfully fetched data')
      log('info', 'Parsing ...')

      const accounts = this.parseAccounts(cards)
      const operations = this.parseOps(ops, cards)
      const categorizedTransactions = await categorize(operations)
      const { accounts: savedAccounts } = await reconciliator.save(
        accounts,
        categorizedTransactions
      )

      log('info', `Saved ${savedAccounts.length} account(s)`)

      const balances = await fetchBalances(savedAccounts)
      await saveBalances(balances)
    } catch (e) {
      log('error', e)
      log('error', e.stack)
      // let the stack report the proper error (LOGIN_FAILED, 2FA...) to Cozy
      // Home instead of silently marking the job as successful
      throw e
    }
  }

  parseAccounts(cards) {
    return cards.map(card => {
      const balance = card.balance || {}
      return {
        vendorId: card.id,
        number: card.id,
        currency: (balance.currency && balance.currency.iso_3) || 'EUR',
        institutionLabel: 'Swile',
        label: card.label,
        balance: balance.value || 0,
        type: 'Checkings'
      }
    })
  }

  parseOps(ops, cards) {
    const knownWalletIds = new Set(cards.map(card => card.id))
    // Only fall back to a single wallet when there is no ambiguity: with
    // several wallets we cannot guess which one an operation belongs to, and
    // attaching it to the wrong account would silently corrupt the balances.
    const fallbackWalletId = cards.length === 1 ? cards[0].id : null
    let skipped = 0

    const operations = ops
      .map(op => {
        const transaction = op.transactions.find(t => t.type === 'ORIGIN')
        if (!transaction) {
          log('warn', `No origin transaction found for ${op.name}`)
          skipped++
          return null
        }
        // Some operations (e.g. top-ups) have no wallet on their origin
        // transaction. The reconciliator requires vendorAccountId to match the
        // vendorId of a saved account, otherwise the whole run throws.
        const wallet = transaction.wallet
        const walletId = wallet ? wallet.uuid : fallbackWalletId
        if (!walletId) {
          log(
            'warn',
            `No wallet on operation "${op.name}" (${op.date}) and ${cards.length} wallets to choose from, skipping it`
          )
          skipped++
          return null
        }
        if (!knownWalletIds.has(walletId)) {
          // Would make BankingReconciliator throw "Transaction without account"
          log(
            'warn',
            `Operation "${op.name}" references unknown wallet ${walletId}, skipping it`
          )
          skipped++
          return null
        }
        const date = new Date(op.date).toISOString()
        return {
          vendorId: transaction.id,
          vendorAccountId: walletId,
          amount: transaction.amount.value / 100,
          date: date,
          dateOperation: date,
          dateImport: new Date().toISOString(),
          currency: transaction.amount.currency.iso_3,
          label: op.name,
          originalBankLabel: op.name
        }
      })
      .filter(Boolean)

    log(
      'info',
      `Parsed ${operations.length} operations from ${ops.length} fetched (${skipped} skipped)`
    )
    return operations
  }
}

const fetchBalances = accounts => {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await getBalanceHistory(currentYear, account._id)
      history.balances[todayAsString] = account.balance

      return history
    })
  )
}

const getBalanceHistory = async (year, accountId) => {
  const index = await cozyClient.data.defineIndex(
    'io.cozy.bank.balancehistories',
    ['year', 'relationships.account.data._id']
  )
  const options = {
    selector: { year, 'relationships.account.data._id': accountId },
    limit: 1
  }
  const [balance] = await cozyClient.data.query(index, options)

  if (balance) {
    log(
      'info',
      `Found a io.cozy.bank.balancehistories document for year ${year} and account ${accountId}`
    )
    return balance
  }

  log(
    'info',
    `io.cozy.bank.balancehistories document not found for year ${year} and account ${accountId}, creating a new one`
  )
  return getEmptyBalanceHistory(year, accountId)
}

const getEmptyBalanceHistory = (year, accountId) => {
  return {
    year,
    balances: {},
    metadata: {
      version: 1
    },
    relationships: {
      account: {
        data: {
          _id: accountId,
          _type: 'io.cozy.bank.accounts'
        }
      }
    }
  }
}

const saveBalances = balances => {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

const connector = new SwileConnector({
  cheerio: false,
  json: false
})

connector.run()
