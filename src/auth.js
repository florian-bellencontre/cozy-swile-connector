const { log, errors } = require('cozy-konnector-libs')
// Node 16 has no global fetch: cozy-konnector-libs assigns global.fetch as a
// side effect, but requiring it explicitly keeps this module independent.
const fetch = require('node-fetch')

const TOKEN_URL = 'https://directory.swile.co/oauth/token'
// OAuth client id of the official Swile web app. It is public: it is shipped
// in the frontend bundle of directory.swile.co.
const CLIENT_ID =
  '533bf5c8dbd05ef18fd01e2bbbab3d7f69e3511dd08402862b5de63b9a238923'

const requestToken = async payload => {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Swile-Platform': 'web'
    },
    body: JSON.stringify({ client_id: CLIENT_ID, ...payload })
  })
  let data = {}
  try {
    data = await response.json()
  } catch (e) {
    // some error responses have no json body
  }
  return { ok: response.ok, status: response.status, data }
}

// Reuse the refresh token saved in the account data by a previous run so
// scheduled runs never need a new 2FA code.
const refreshSession = async connector => {
  let auth
  try {
    auth = connector.getAccountData().auth
  } catch (e) {
    return null
  }
  if (!auth || !auth.refreshToken) {
    return null
  }
  log('info', 'Refreshing the saved Swile session')
  const result = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken
  })
  if (!result.ok) {
    log('info', 'Saved session rejected, falling back to password login')
    return null
  }
  return result
}

// waitForTwoFaCode needs a manual run from Cozy Home; in standalone/dev mode
// the stub never receives the code so we read it from the terminal instead.
const getTwoFaCode = (connector, channel) => {
  const type = channel === 'sms' ? 'sms' : 'email'
  if (['standalone', 'development', 'test'].includes(process.env.NODE_ENV)) {
    const readline = require('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    return new Promise(resolve =>
      rl.question(`Enter the 2FA code received by ${type}: `, answer => {
        rl.close()
        resolve(answer.trim())
      })
    )
  }
  return connector.waitForTwoFaCode({ type })
}

const saveSession = async (connector, data) => {
  try {
    await connector.saveAccountData({
      auth: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token
      }
    })
  } catch (e) {
    log('warn', `Could not save the Swile session: ${e.message}`)
  }
}

module.exports = {
  getToken: async function (connector, username, password) {
    let result = await refreshSession(connector)
    let askedTwoFa = false

    if (!result) {
      result = await requestToken({
        grant_type: 'password',
        username,
        password
      })

      if (!result.ok && result.data.error === 'missing_authentication_code') {
        // The rejected call above made Swile send an OTP to the user
        askedTwoFa = true
        log('info', `2FA code sent by ${result.data.channel}`)
        const code = await getTwoFaCode(connector, result.data.channel)
        result = await requestToken({
          grant_type: 'password',
          username,
          password,
          authentication_code: code
        })
      }
    }

    if (!result.ok) {
      log('error', `Swile auth failed: ${result.status}`)
      log('error', JSON.stringify(result.data))
      if (askedTwoFa) {
        throw new Error(errors.USER_ACTION_NEEDED_WRONG_TWOFA_CODE)
      }
      throw new Error(
        result.data.error === 'invalid_grant'
          ? errors.LOGIN_FAILED
          : errors.VENDOR_DOWN
      )
    }

    await connector.notifySuccessfulLogin()
    await saveSession(connector, result.data)
    return result.data.access_token
  }
}
