import { Job } from 'bullmq'
import {
  Blocks,
  EmojiReaction,
  FederatedHost,
  Follows,
  Mutes,
  Post,
  PostMentionsUserRelation,
  User,
  UserLikesPostRelations,
  UserOptions,
  sequelize
} from '../../models/index.js'
import { completeEnvironment } from '../backendOptions.js'
import { getUserIdFromRemoteId } from '../cacheGetters/getUserIdFromRemoteId.js'
import { getPetitionSigned } from '../activitypub/getPetitionSigned.js'
import { processUserEmojis } from '../activitypub/processUserEmojis.js'
import { fediverseTag } from '../../interfaces/fediverse/tags.js'
import { logger } from '../logger.js'
import { redisCache } from '../redis.js'
import { Op } from 'sequelize'
import { getDeletedUser } from '../cacheGetters/getDeletedUser.js'

// This function will return userid after processing it.
async function getRemoteActorIdProcessor(job: Job) {
  const actorUrl: string = job.data.actorUrl
  const forceUpdate: boolean = job.data.forceUpdate
  let res: string | User | undefined | null = await getUserIdFromRemoteId(actorUrl)
  let url = undefined
  try {
    url = new URL(actorUrl)
  } catch (error) {
    res = await getDeletedUser()
    url = undefined
    logger.debug({
      message: `Invalid url ${actorUrl}`,
      url: actorUrl,
      stack: new Error().stack
    })
  }
  if (res === '' || (forceUpdate && url != undefined)) {
    let federatedHost = await FederatedHost.findOne({
      where: sequelize.where(
        sequelize.fn('lower', sequelize.col('displayName')),
        url?.host ? url.host.toLowerCase() : ''
      )
    })
    const hostBanned = federatedHost?.blocked
    if (hostBanned) {
      res = await getDeletedUser()
    } else {
      const user = await User.findByPk(job.data.userId)
      const userPetition = await getPetitionSigned(user, actorUrl)
      if (userPetition) {
        if (!federatedHost && url) {
          const federatedHostToCreate = {
            displayName: url.host.toLocaleLowerCase(),
            publicInbox: userPetition.endpoints?.sharedInbox ? userPetition.endpoints?.sharedInbox : ''
          }
          federatedHost = (await FederatedHost.findOrCreate({ where: federatedHostToCreate }))[0]
        }
        if (!url || !federatedHost) {
          logger.warn({ message: 'Url is not valid wtf', trace: new Error().stack })
          return await getDeletedUser()
        }
        const remoteMentionUrl = typeof userPetition.url === 'string' ? userPetition.url : ''
        let followers = 0
        let followed = 0
        if (userPetition.followers) {
          const followersPetition = await getPetitionSigned(user, userPetition.followers)
          if (followersPetition && followersPetition.totalItems) {
            followers = followersPetition.totalItems
          }
        }
        if (userPetition.following) {
          const followingPetition = await getPetitionSigned(user, userPetition.following)
          if (followingPetition && followingPetition.totalItems) {
            followed = followingPetition.totalItems
          }
        }
        const userData = {
          hideFollows: false,
          hideProfileNotLoggedIn: false,
          url: `@${userPetition.preferredUsername}@${url?.host}`,
          name: userPetition.name ? userPetition.name : userPetition.preferredUsername,
          email: null,
          description: userPetition.summary ? userPetition.summary : '',
          avatar: userPetition.icon?.url
            ? userPetition.icon.url
            : `${completeEnvironment.mediaUrl}/uploads/default.webp`,
          headerImage: userPetition?.image?.url ? userPetition.image.url.toString() : ``,
          password: 'NOT_A_WAFRN_USER_NOT_REAL_PASSWORD',
          publicKey: userPetition.publicKey?.publicKeyPem,
          remoteInbox: userPetition.inbox,
          remoteId: actorUrl,
          activated: true,
          federatedHostId: federatedHost.id,
          remoteMentionUrl: remoteMentionUrl,
          followersCollectionUrl: userPetition.followers,
          followingCollectionUrl: userPetition.following,
          isBot: userPetition.type != 'Person',
          followerCount: followers,
          followingCount: followed,
          createdAt: userPetition.published ? new Date(userPetition.published) : new Date(),
          updatedAt: new Date(),
          NSFW: false,
          birthDate: new Date(),
          userMigratedTo: userPetition.movedTo || ''
        }
        federatedHost.publicInbox = userPetition.endpoints?.sharedInbox
        await federatedHost.save()
        let userRes
        const existingUsers = await User.findAll({
          where: {
            [Op.or]: [
              sequelize.where(sequelize.fn('lower', sequelize.col('url')), userData.url.toLowerCase()),
              {
                remoteId: userData.remoteId
              }
            ]
          }
        })
        if (res) {
          if (res !== (await getDeletedUser())) {
            userRes = await User.findByPk(res as string)
            if (existingUsers.length > 1) {
              logger.debug({
                message: `Multiple fedi users found for ${userData.url} (${userData.remoteId}): ${existingUsers.length}`
              })
              for await (const userWithDuplicatedData of existingUsers.slice(1)) {
                userWithDuplicatedData.url = userWithDuplicatedData.url + '_DUPLICATED_' + new Date().getTime()
                userWithDuplicatedData.remoteId =
                  userWithDuplicatedData.remoteId + '_DUPLICATED_' + new Date().getTime()
              }
            }
            if (existingUsers && existingUsers.length > 0 && existingUsers[0] && userRes?.id !== existingUsers[0]?.id) {
              const existingUser = existingUsers[0]
              existingUser.activated = false
              existingUser.remoteId = `${existingUser.remoteId}_OVERWRITTEN_ON${new Date().getTime()}`
              existingUser.url = `${existingUser.url}_OVERWRITTEN_ON${new Date().getTime()}`
              await existingUser.save()
              if (userRes) {
                const updates = [
                  Follows.update(
                    {
                      followerId: userRes.id
                    },
                    {
                      where: {
                        followerId: existingUser.id
                      }
                    }
                  ),
                  Follows.update(
                    {
                      followedId: userRes.id
                    },
                    {
                      where: {
                        followedId: existingUser.id
                      }
                    }
                  ),
                  Post.update(
                    {
                      userId: userRes.id
                    },
                    {
                      where: {
                        userId: existingUser.id
                      }
                    }
                  ),
                  UserLikesPostRelations.update(
                    {
                      userId: userRes.id
                    },
                    {
                      where: {
                        userId: existingUser.id
                      }
                    }
                  ),
                  EmojiReaction.update(
                    {
                      userId: userRes.id
                    },
                    {
                      where: {
                        userId: existingUser.id
                      }
                    }
                  ),
                  Blocks.update(
                    {
                      blockedId: userRes.id
                    },
                    {
                      where: {
                        blockedId: existingUser.id
                      }
                    }
                  ),
                  Blocks.update(
                    {
                      blockerId: userRes.id
                    },
                    {
                      where: {
                        blockerId: existingUser.id
                      }
                    }
                  ),
                  Mutes.update(
                    {
                      muterId: userRes.id
                    },
                    {
                      where: {
                        muterId: existingUser.id
                      }
                    }
                  ),
                  Mutes.update(
                    {
                      mutedId: userRes.id
                    },
                    {
                      where: {
                        mutedId: existingUser.id
                      }
                    }
                  ),
                  PostMentionsUserRelation.update(
                    {
                      userId: userRes.id
                    },
                    {
                      where: {
                        userId: existingUser.id
                      }
                    }
                  )
                ]
                await Promise.all(updates)
              }
              await redisCache.del('userRemoteId:' + existingUser.remoteId)
            }
            if (userRes) {
              userRes.set(userData)
              await userRes.save()
            } else {
              redisCache.del('userRemoteId:' + actorUrl.toLocaleLowerCase())
            }
          }
        } else {
          if (existingUsers && existingUsers[0]) {
            existingUsers[0].set(userData)
            await existingUsers[0].save()
          } else {
            userRes = await User.create(userData)
          }
        }
        if (
          userRes &&
          userRes.id &&
          userRes.url != completeEnvironment.deletedUser &&
          userPetition &&
          userPetition.attachment &&
          userPetition.attachment.length
        ) {
          await UserOptions.destroy({
            where: {
              userId: userRes.id,
              optionName: {
                [Op.like]: 'fediverse.public.attachment'
              }
            }
          })
          const properties = userPetition.attachment.filter((elem: any) => elem.type === 'PropertyValue')
          await UserOptions.create({
            userId: userRes.id,
            optionName: `fediverse.public.attachment`,
            optionValue: JSON.stringify(properties),
            public: true
          })
        }
        res = userRes?.id ? userRes.id : await getDeletedUser()
        try {
          if (userRes) {
            const tags = userPetition?.tag
              ? Array.isArray(userPetition.tag)
                ? userPetition.tag
                : [userPetition.tag]
              : []
            const emojis = [...new Set(tags.filter((elem: fediverseTag) => elem.type === 'Emoji'))]
            await processUserEmojis(userRes, emojis)
          }
        } catch (error) {
          logger.info({
            message: `Error processing emojis from user ${userRes?.url}`,
            error: error,
            tags: userPetition?.tag,
            userPetition: userPetition
          })
        }
      }
    }
  }
  return res
}

export { getRemoteActorIdProcessor }
