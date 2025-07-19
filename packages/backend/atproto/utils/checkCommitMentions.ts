import { ParsedCommit } from '@skyware/firehose'
import { Post } from '../../models/index.js'
import { Op, Sequelize } from 'sequelize'
import { getAllLocalUserIds } from '../../utils/cacheGetters/getAllLocalUserIds.js'
import { RichText } from '@atproto/api'

// Preemptive checks to see if
function checkCommitMentions(
  commit: ParsedCommit,
  cacheData: {
    followedDids: Set<string>
    localUserDids: Set<string>
    followedUsersLocalIds: Set<string>
    followedHashtags: Set<string>
  }
): boolean {
  const didsToCheck = cacheData.followedDids

  let res = false
  // first we check if there are any mentions to local users. if so we return true
  for (const operation of commit.ops) {
    // TODO nuke this
    if (operation.path.startsWith('app.bsky.feed.like') || operation.path.startsWith('app.bsky.graph.follow')) {
      //return false
    }
    // we check lik
    if (
      operation.action === 'create' &&
      (operation.path.startsWith('app.bsky.feed.like') || operation.path.startsWith('app.bsky.graph.follow'))
    ) {
      let record: any = operation.record
      // we do not ned 18k likes on a mark hamill post. We better do just a "people you follow liked..."
      let likedPostUri = record?.subject?.uri ? record?.subject.uri : ''
      if (likedPostUri) {
        likedPostUri = likedPostUri.split('/')[2]
      }
      let followedUser = operation.path.startsWith('app.bsky.graph.follow') ? record?.subject : ''

      if (
        didsToCheck.has(commit.repo) ||
        cacheData.localUserDids.has(likedPostUri) ||
        cacheData.localUserDids.has(followedUser)
      ) {
        return true
      }
    }
    if (
      operation.action === 'create' &&
      operation.path.startsWith('app.bsky.feed.post') &&
      (operation.record as any)?.facets
    ) {
      let record: any = operation.record
      const mentions = record?.facets
        .flatMap((elem: any) => elem.features)
        .map((elem: any) => elem.did)
        .filter((elem: any) => elem)

      if (record.text) {
        const rt = new RichText({
          text: record.text,
          facets: record.facets
        })
        let tags = rt.segments().filter((elem) => elem.isTag())
        if (tags && tags.some((tag) => cacheData.followedHashtags.has(tag.text.substring(1).toLowerCase()))) {
          res = true
          return true
        }
      }

      if (mentions && mentions.length && mentions.some((mention: string) => cacheData.localUserDids.has(mention))) {
        res = true
        return res
      }
    }
  }
  // second one first approach: is post being replied on db? if so we store it.
  const urisToCheck: string[] = commit.ops
    .filter((op) => op.action === 'create' && op.path.startsWith('app.bsky.feed.post') && (op.record as any)?.reply)
    .map((op) => {
      return { parent: (op as any).record.reply.parent.uri, root: (op as any).record.reply.root.uri }
    })
    .map((elem) => [elem.parent, elem.root])
    .flat()
    .map((elem) => elem.split('at://')[1])
    .map((elem) => elem.split('/app.bsky.feed')[0])
  let postsFounds = 0

  if (urisToCheck.length > 0) {
    // TODO oh no lets lower the thing a bit
    // postsFounds = urisToCheck.some((elem) => didsToCheck.has(elem)) ? 1 : postsFounds
    postsFounds = urisToCheck.some((elem) => cacheData.followedDids.has(elem) || cacheData.localUserDids.has(elem))
      ? 1
      : postsFounds
  }

  if (postsFounds > 0) {
    res = true
  }
  return res
}

export { checkCommitMentions }
