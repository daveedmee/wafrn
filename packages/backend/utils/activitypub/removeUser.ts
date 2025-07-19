import { Op } from 'sequelize'
import {
  EmojiReaction,
  Follows,
  Media,
  Post,
  PostMentionsUserRelation,
  PostTag,
  QuestionPollAnswer,
  sequelize,
  User,
  UserEmojiRelation
} from '../../models/index.js'
import { completeEnvironment } from '../backendOptions.js'
import { logger } from '../logger.js'
import { redisCache } from '../redis.js'

async function removeUser(userId: string) {
  let deleted = false
  try {
    const userToRemove = await User.findOne({ where: { remoteId: userId } })
    if (userToRemove) {
      const ownerOfDeletedPost = await User.findOne({
        where: {
          url: completeEnvironment.deletedUser
        }
      })
      if (!ownerOfDeletedPost) return

      const postsIdsStringQuery = `"postId" IN (select "id" FROM "posts" WHERE "userId"='${userToRemove.id}')`
      userToRemove.activated = false
      await Post.update(
        {
          userId: ownerOfDeletedPost.id,
          content: 'Post has been deleted because remote user has been deleted',
          isDeleted: true
        },
        {
          where: {
            userId: userToRemove.id
          }
        }
      )
      await Media.destroy({
        where: sequelize.literal(postsIdsStringQuery)
      })
      await PostTag.destroy({
        where: sequelize.literal(postsIdsStringQuery)
      })
      await Follows.destroy({
        where: {
          [Op.or]: [
            {
              followerId: userToRemove.id
            },
            {
              followedId: userToRemove.id
            }
          ]
        }
      })
      await PostMentionsUserRelation.update(
        {
          userId: ownerOfDeletedPost.id
        },
        {
          where: {
            userId: userToRemove.id
          }
        }
      )
      await EmojiReaction.destroy({
        where: {
          userId: userToRemove.id
        }
      })
      await UserEmojiRelation.destroy({
        where: {
          userId: userToRemove.id
        }
      })
      await QuestionPollAnswer.destroy({
        where: {
          userId: userToRemove.id
        }
      })
      //await userToRemove.save()
      redisCache.del('userRemoteId:' + userToRemove.remoteId.toLocaleLowerCase())
      await userToRemove.destroy()
      deleted = true
    }
  } catch (error) {
    logger.trace({
      message: 'Error deleting user',
      error: error,
      userId: userId
    })
  }
  return deleted
}

export { removeUser }
