const puppeteer = require('puppeteer')
const { log } = require('cozy-konnector-libs')
const fs = require('fs')

const baseUrl = 'https://team.swile.co'
const walletUrl = `${baseUrl}/wallets`

module.exports = {
  getToken: async function (connector, username, password) {
    log('info', 'Get token')
    let dataDir = `./data/${username}`
    // create data dir if it doesn't exist
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir)
    }
    let browser = await puppeteer.launch({
      headless: false,
      userDataDir: dataDir
    })
    let page = await browser.newPage()
    await page.goto(walletUrl)
    // wait for idle
    await page.waitForTimeout(1000)
    try {
      await page.waitForFunction(`window.location.href === "${walletUrl}"`, {
        timeout: 5000
      })
    } catch (e) {
      log('info', 'Not logged in, logging in...')
      // original auth code from @Guekka
      await page.waitForSelector('form', { timeout: 1000 })

      const form = await page.$('form')

      // reject cookies
      try {
        await page
          .waitForSelector('#onetrust-reject-all-handler', { timeout: 2000 })
          .then(el => el.click())
      } catch (e) {
        log('info', 'No cookie banner')
      }

      await form.$('input[name="username"]').then(el => el.type(username))
      await page.waitForTimeout(1000)
      await form.$('button#submit').then(el => el.click())
      await page.waitForTimeout(1000)
      await form.$('input[name="password"]').then(el => el.type(password))

      await page.waitForTimeout(1000)

      await form
        .waitForSelector('button[type="submit"]', { timeout: 20000 })
        .then(el => el.click())
      await page.waitForFunction(`window.location.href === "${walletUrl}"`, {
        timeout: 40000
      })
    }

    const jwt = await page.cookies().then(cookies => {
      return cookies.find(c => c.name === 'lunchr:jwt').value
    })

    await connector.notifySuccessfulLogin()

    await browser.close()
    return jwt
  }
}
