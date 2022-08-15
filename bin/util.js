import rssParser from "rss-parser";
import path from "path";
import fs from "fs";
import dayjs from "dayjs";
import got from "got";
import util from "util";
import { exec } from "child_process";
import xml2js from "xml2js";

import { logErrorAndExit, logMessage } from "./logger.js";
import { getArchiveFilename, getFilename } from "./naming.js";

const execWithPromise = util.promisify(exec);

class RSSParser extends rssParser {
  buildAtomFeed(xmlObj) {
    const feed = super.buildAtomFeed(xmlObj);
    feed.raw = { ...xmlObj };
    delete feed.raw.feed;
    return feed;
  }

  parseItemAtom(entry) {
    const item = super.parseItemAtom(entry);
    item.raw = entry;
    return item;
  }

  buildRSS(channel, items) {
    const feed = super.buildRSS(channel, items);
    feed.raw = { ...channel };
    delete feed.raw.item;
    return feed;
  }

  parseItemRss(xmlItem, itemFields) {
    const item = super.parseItemRss(xmlItem, itemFields);
    item.raw = xmlItem;
    return item;
  }
}

const parser = new RSSParser({
  defaultRSS: 2.0,
});

const builder = new xml2js.Builder();

const getTempPath = (path) => {
  return `${path}.tmp`;
};

const getArchiveKey = ({ prefix, name }) => {
  return `${prefix}-${name}`;
};

const getArchive = (archive) => {
  const archivePath = path.resolve(process.cwd(), archive);

  if (!fs.existsSync(archivePath)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(archivePath));
};

const writeToArchive = ({ key, archive }) => {
  const archivePath = path.resolve(process.cwd(), archive);
  const archiveResult = getArchive(archive);

  if (!archiveResult.includes(key)) {
    archiveResult.push(key);
  }

  fs.writeFileSync(archivePath, JSON.stringify(archiveResult, null, 4));
};

const getIsInArchive = ({ key, archive }) => {
  const archiveResult = getArchive(archive);
  return archiveResult.includes(key);
};

const getPossibleUrlEmbeds = (url, maxAmount = 5) => {
  const fullUrl = new URL(url);
  const possibleStartIndexes = [];

  for (let i = 0; i < fullUrl.pathname.length; i++) {
    if (fullUrl.pathname[i] === "/") {
      possibleStartIndexes.push(i);
    }
  }

  const possibleEmbedChoices = possibleStartIndexes.map((startIndex) => {
    let possibleEmbed = fullUrl.pathname.slice(startIndex + 1);

    if (!possibleEmbed.startsWith("http")) {
      possibleEmbed = `https://${possibleEmbed}`;
    }

    return decodeURIComponent(possibleEmbed);
  });

  return possibleEmbedChoices
    .slice(Math.max(possibleEmbedChoices.length - maxAmount, 0))
    .reverse();
};

const getUrlEmbed = async (url) => {
  const possibleUrlEmbeds = getPossibleUrlEmbeds(url);
  for (const possibleUrl of possibleUrlEmbeds) {
    try {
      const embeddedUrl = new URL(possibleUrl);
      await got(embeddedUrl.href, {
        timeout: 3000,
        method: "HEAD",
        responseType: "json",
        headers: {
          accept: "*/*",
        },
      });

      return embeddedUrl;
    } catch (error) {
      // do nothing
    }
  }

  return null;
};

const getLoopControls = ({ offset, length, reverse }) => {
  if (reverse) {
    const startIndex = length - 1 - offset;
    const min = -1;
    const shouldGo = (i) => i > min;
    const decrement = (i) => i - 1;

    return {
      startIndex,
      shouldGo,
      next: decrement,
    };
  }

  const startIndex = 0 + offset;
  const max = length;
  const shouldGo = (i) => i < max;
  const increment = (i) => i + 1;

  return {
    startIndex,
    shouldGo,
    next: increment,
  };
};

const getItemsToDownload = ({
  archive,
  archiveUrl,
  basePath,
  feed,
  limit,
  offset,
  reverse,
  before,
  after,
  episodeRegex,
  episodeTemplate,
  includeEpisodeImages,
}) => {
  const { startIndex, shouldGo, next } = getLoopControls({
    offset,
    reverse,
    length: feed.items.length,
  });

  let i = startIndex;
  const items = [];

  const savedArchive = archive ? getArchive(archive) : [];

  while (shouldGo(i)) {
    const { title, pubDate } = feed.items[i];
    const pubDateDay = dayjs(new Date(pubDate));
    let isValid = true;

    if (episodeRegex) {
      const generatedEpisodeRegex = new RegExp(episodeRegex);
      if (title && !generatedEpisodeRegex.test(title)) {
        isValid = false;
      }
    }

    if (before) {
      const beforeDateDay = dayjs(new Date(before));
      if (
        !pubDateDay.isSame(beforeDateDay, "day") &&
        !pubDateDay.isBefore(beforeDateDay, "day")
      ) {
        isValid = false;
      }
    }

    if (after) {
      const afterDateDay = dayjs(new Date(after));
      if (
        !pubDateDay.isSame(afterDateDay, "day") &&
        !pubDateDay.isAfter(afterDateDay, "day")
      ) {
        isValid = false;
      }
    }

    const { url: episodeAudioUrl, ext: audioFileExt } =
      getEpisodeAudioUrlAndExt(feed.items[i]);
    const key = getArchiveKey({
      prefix: archiveUrl,
      name: getArchiveFilename({
        pubDate,
        name: title,
        ext: audioFileExt,
      }),
    });

    if (key && savedArchive.includes(key)) {
      isValid = false;
    }

    if (isValid) {
      const item = feed.items[i];
      item._originalIndex = i;
      item._extra_downloads = [];

      if (includeEpisodeImages) {
        const episodeImageUrl = getImageUrl(item);

        if (episodeImageUrl) {
          const episodeImageFileExt = getUrlExt(episodeImageUrl);
          const episodeImageArchiveKey = getArchiveKey({
            prefix: archiveUrl,
            name: getArchiveFilename({
              pubDate,
              name: title,
              ext: episodeImageFileExt,
            }),
          });

          const episodeImageName = getFilename({
            item,
            feed,
            url: episodeAudioUrl,
            ext: episodeImageFileExt,
            template: episodeTemplate,
          });

          const outputImagePath = path.resolve(
            basePath,
            item.guid,
            episodeImageName
          );
          item._extra_downloads.push({
            url: episodeImageUrl,
            outputPath: outputImagePath,
            key: episodeImageArchiveKey,
          });
        }
      }

      items.push(item);
    }

    i = next(i);
  }

  return limit ? items.slice(0, limit) : items;
};

const logFeedInfo = (feed) => {
  logMessage(feed.title);
  logMessage(feed.description);
  logMessage();
};

const ITEM_LIST_FORMATS = {
  table: "table",
  json: "json",
};

const logItemsList = ({
  type,
  feed,
  limit,
  offset,
  reverse,
  before,
  after,
  episodeRegex,
}) => {
  const items = getItemsToDownload({
    feed,
    limit,
    offset,
    reverse,
    before,
    after,
    episodeRegex,
  });

  const tableData = items.map((item) => {
    return {
      episodeNum: feed.items.length - item._originalIndex,
      title: item.title,
      pubDate: item.pubDate,
    };
  });

  if (!tableData.length) {
    logErrorAndExit("No episodes found with provided criteria to list");
  }

  if (type === ITEM_LIST_FORMATS.json) {
    console.log(JSON.stringify(tableData));
  } else {
    console.table(tableData);
  }
};

const METADATA_FORMATS = {
  json: "json",
  xml: "xml",
};

const writeMeta = (path, data) => {
  const format = path.split(".").pop();
  if (format == METADATA_FORMATS.json) {
    fs.writeFileSync(path, JSON.stringify(data, null, 4));
  } else if (format == METADATA_FORMATS.xml) {
    fs.writeFileSync(path, builder.buildObject(data));
  } else {
    throw new Error(`Invalid metadata path ${path}`);
  }
};

const writeFeedMeta = ({
  outputPath,
  feed,
  key,
  archive,
  override,
  fields,
}) => {
  if (key && archive && getIsInArchive({ key, archive })) {
    logMessage("Feed metadata exists in archive. Skipping...");
    return;
  }

  const metadata = getFields(feed, fields);
  delete metadata.items;

  try {
    if (override || !fs.existsSync(outputPath)) {
      writeMeta(outputPath, metadata);
    } else {
      logMessage("Feed metadata exists locally. Skipping...");
    }

    if (key && archive && !getIsInArchive({ key, archive })) {
      try {
        writeToArchive({ key, archive });
      } catch (error) {
        throw new Error(`Error writing to archive: ${error.toString()}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Unable to save metadata file for feed: ${error.toString()}`
    );
  }
};

const writeItemMeta = ({
  marker,
  outputPath,
  item,
  key,
  archive,
  override,
  fields,
}) => {
  if (key && archive && getIsInArchive({ key, archive })) {
    logMessage(`${marker} | Episode metadata exists in archive. Skipping...`);
    return;
  }

  const metadata = getFields(item, fields);

  try {
    if (override || !fs.existsSync(outputPath)) {
      writeMeta(outputPath, metadata);
    } else {
      logMessage(`${marker} | Episode metadata exists locally. Skipping...`);
    }

    if (key && archive && !getIsInArchive({ key, archive })) {
      try {
        writeToArchive({ key, archive });
      } catch (error) {
        throw new Error("Error writing to archive", error);
      }
    }
  } catch (error) {
    throw new Error("Unable to save meta file for episode", error);
  }
};

const getUrlExt = (url) => {
  const { pathname } = new URL(url);

  if (!pathname) {
    return "";
  }

  const ext = path.extname(pathname);
  return ext;
};

const AUDIO_TYPES_TO_EXTS = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/vorbis": ".ogg",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/aac": ".aac",
};

const VALID_AUDIO_EXTS = [...new Set(Object.values(AUDIO_TYPES_TO_EXTS))];

const getIsAudioUrl = (url) => {
  const ext = getUrlExt(url);

  if (!ext) {
    return false;
  }

  return VALID_AUDIO_EXTS.includes(ext);
};

const getEpisodeAudioUrlAndExt = ({ enclosure, link }) => {
  if (link && getIsAudioUrl(link)) {
    return { url: link, ext: getUrlExt(link) };
  }

  if (enclosure && getIsAudioUrl(enclosure.url)) {
    return { url: enclosure.url, ext: getUrlExt(enclosure.url) };
  }

  if (enclosure && enclosure.url && AUDIO_TYPES_TO_EXTS[enclosure.type]) {
    return { url: enclosure.url, ext: AUDIO_TYPES_TO_EXTS[enclosure.type] };
  }

  return { url: null, ext: null };
};

const getImageUrl = ({ image, itunes }) => {
  if (image && image.url) {
    return image.url;
  }

  if (image && image.link) {
    return image.link;
  }

  if (itunes && itunes.image) {
    return itunes.image;
  }

  return null;
};

const getFeed = async (url) => {
  const { href } = new URL(url);

  let feed;
  try {
    feed = await parser.parseURL(href);
  } catch (err) {
    logErrorAndExit("Unable to parse RSS URL", err);
  }

  return feed;
};

const globToRegExp = (glob) => {
  const pattern = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace("**", ".+")
    .replace("*", "[^.]+");
  return RegExp(`^${pattern}$`);
};

const processFieldRules = (patterns) =>
  patterns.map((pattern) => {
    let include = true;
    if (pattern.startsWith("!")) {
      include = false;
      pattern = pattern.substring(1);
    } else if (pattern.startsWith("\\!")) {
      pattern = pattern.substring(1);
    }

    return {
      include,
      pattern: globToRegExp(pattern),
    };
  });

const applyFieldRules = (object, rules, prefix) => {
  const result = {};

  const getToInclude = (value, fullKey) => {
    if (Array.isArray(value)) {
      const nested = value
        .map((item) => getToInclude(item, fullKey))
        .filter((item) => item !== undefined);
      if (nested.length) {
        return nested;
      }
    } else if (value !== null && typeof value === "object") {
      const nested = applyFieldRules(value, rules, `${fullKey}.`);
      if (Object.keys(nested).length) {
        return nested;
      }
    } else {
      const matchingRule = rules.find((rule) => rule.pattern.test(fullKey));
      if (matchingRule && matchingRule.include) {
        return value;
      }
    }
    return undefined;
  };

  Object.entries(object).forEach(([key, value]) => {
    // Always include special properties $ (which contains attributes of the XML tag) and _ (which contains any text
    // directly inside the tag), because filtering these is non-intuitive (expecially for the XML export).
    if (key === "$" || key === "_") {
      result[key] = value;
      return;
    }

    const fullKey = `${prefix}${key}`;
    const toInclude = getToInclude(value, fullKey);
    if (toInclude !== undefined) {
      result[key] = toInclude;
    }
  });

  return result;
};

const getFields = (object, patterns) => {
  const rules = processFieldRules(patterns);
  // We're really only interested in the last rule that matches, so the list is more useful to us in reverse.
  rules.reverse();
  return applyFieldRules(object, rules, "");
};

const runFfmpeg = async ({
  feed,
  item,
  itemIndex,
  outputPath,
  bitrate,
  mono,
  addMp3Metadata,
}) => {
  if (!fs.existsSync(outputPath)) {
    return;
  }

  if (!outputPath.endsWith(".mp3")) {
    throw new Error("Not an .mp3 file. Unable to run ffmpeg.");
  }

  let command = `ffmpeg -loglevel quiet -i "${outputPath}"`;

  if (bitrate) {
    command += ` -b:a ${bitrate}`;
  }

  if (mono) {
    command += " -ac 1";
  }

  if (addMp3Metadata) {
    const album = feed.title || "";
    const title = item.title || "";
    const artist =
      item.itunes && item.itunes.author
        ? item.itunes.author
        : item.author || "";
    const track =
      item.itunes && item.itunes.episode
        ? item.itunes.episode
        : `${feed.items.length - itemIndex}`;
    const date = item.pubDate
      ? dayjs(new Date(item.pubDate)).format("YYYY-MM-DD")
      : "";

    const metaKeysToValues = {
      album,
      artist,
      title,
      track,
      date,
      album_artist: album,
    };

    const metadataString = Object.keys(metaKeysToValues)
      .map((key) =>
        metaKeysToValues[key]
          ? `-metadata ${key}="${metaKeysToValues[key].replace(/"/g, '\\"')}"`
          : null
      )
      .filter((segment) => !!segment)
      .join(" ");

    command += ` -map_metadata 0 ${metadataString} -codec copy`;
  }

  const tmpMp3Path = `${outputPath}.tmp.mp3`;
  command += ` "${tmpMp3Path}"`;

  try {
    await execWithPromise(command, { stdio: "ignore" });
  } catch (error) {
    if (fs.existsSync(tmpMp3Path)) {
      fs.unlinkSync(tmpMp3Path);
    }

    throw error;
  }

  fs.unlinkSync(outputPath);
  fs.renameSync(tmpMp3Path, outputPath);
};

const runExec = async ({ exec, outputPodcastPath, episodeFilename }) => {
  const filenameBase = episodeFilename.substring(
    0,
    episodeFilename.lastIndexOf(".")
  );
  const execCmd = exec
    .replace(/{}/g, `"${outputPodcastPath}"`)
    .replace(/{filenameBase}/g, `"${filenameBase}"`);

  await execWithPromise(execCmd, { stdio: "ignore" });
};

export {
  getArchive,
  getIsInArchive,
  getArchiveKey,
  writeToArchive,
  getEpisodeAudioUrlAndExt,
  getFeed,
  getImageUrl,
  getItemsToDownload,
  getTempPath,
  getUrlExt,
  getUrlEmbed,
  logFeedInfo,
  ITEM_LIST_FORMATS,
  logItemsList,
  METADATA_FORMATS,
  writeFeedMeta,
  writeItemMeta,
  runFfmpeg,
  runExec,
};
