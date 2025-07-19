import { User } from '../../models/index.js'
import { completeEnvironment } from '../backendOptions.js'
import { redisCache } from '../redis.js'

async function getUserIdFromRemoteId(remoteId: string): Promise<string> {
  let res = ''
  const cacheResult = await redisCache.get('userRemoteId:' + remoteId.toLocaleLowerCase())
  if (cacheResult) {
    res = cacheResult
  } else {
    const user = remoteId.startsWith(completeEnvironment.frontendUrl)
      ? await User.findOne({
          attributes: ['id'],
          where: {
            url: remoteId.split(`${completeEnvironment.instanceUrl}/fediverse/blog/`)[1].split('@')[0]
          }
        })
      : await User.findOne({
          attributes: ['id'],
          where: {
            remoteId: remoteId
          }
        })
    if (user) {
      res = user.id
      await redisCache.set('userRemoteId:' + remoteId.toLocaleLowerCase(), res, 'EX', 1000)
    }
  }
  return res
}

export { getUserIdFromRemoteId }
