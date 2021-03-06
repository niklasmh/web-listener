import fs from "fs";
import fetch from "node-fetch";
import notifier from "node-notifier";
import open from "open";
import { JSDOM } from "jsdom";
import { WebClient } from "@slack/web-api";
import dotenvFlow from "dotenv-flow";

dotenvFlow.config();

const slackToken = process.env.SLACK_TOKEN;
const slack = new WebClient(slackToken);
const slackUsers = process.env.USERS.split(",")
  .concat(["channel:channel"])
  .reduce((acc, user) => {
    const [name, id] = user.split(":");
    return { ...acc, [name]: id };
  }, {});
const isHeadless = process.env.HEADLESS === "true";
const isFunction = process.env.FUNCTION === "true";

const debugAll = false;

const listeners = [];
try {
  const listenersFileContent = isHeadless
    ? await fetch(process.env.LISTENERS_URL).then((r) => r.text())
    : fs.readFileSync("./listeners.txt", "utf8");
  const listenerList = listenersFileContent
    .trim()
    .split("\n")
    .filter((url) => !url.startsWith("#"));
  const fetchListeners = listenerList.map(async (url) => {
    const extension = url.split(".").slice(-1)[0].trim();
    if (extension === "json") {
      return await fetch(url).then((r) => r.json());
    }
    if (extension === "md") {
      const markdown = await fetch(url).then((r) => r.text());
      const listenerSections = markdown.split(/^# /gm).slice(1);
      return listenerSections.map((section) => {
        const [name, ...codes] = section.trim().split("```");
        const config = codes
          .find((code) => code.startsWith("yaml"))
          .trim()
          .split("\n")
          .slice(1)
          .reduce((c, item) => {
            let [key, value] = item.split(": ");
            value = value.trim();
            if (/^[0-9]+$/.test(value)) {
              value = parseInt(value);
            }
            return {
              ...c,
              [key]: value,
            };
          }, {});
        const pipeline = codes
          .filter((code) => code.startsWith("javascript") || code.startsWith("fetch"))
          .map((code) => code.split("\n").slice(1).join("\n").trim());
        return {
          name: name.trim(),
          ...config,
          pipeline,
        };
      });
    }
  });
  (await Promise.all(fetchListeners)).forEach((listener) => {
    if (Array.isArray(listener)) {
      listener.forEach((l) => {
        listeners.push(l);
      });
    } else {
      listeners.push(listener);
    }
  });
} catch (e) {
  console.log(e);
}

let time = 0;
const dt = 10;
let store = {};
try {
  store = JSON.parse(fs.readFileSync("./store.json", "utf8"));
} catch (e) {}

const execCode = (code, state) => {
  if (!code.includes("return ")) code = "return " + code.trim();
  return new Function(`with(this) {
  with(this.value) {
    try {
      ${code}
    } catch (e) {}
    return false
  }
}`).bind(state)();
};

const parseUrl = (url, state) => {
  if (url.startsWith('"') || url.includes("return ")) return execCode(url, state);
  return url;
};

const checkListeners = async (time) => {
  const processes = listeners.map(async (listener) => {
    const {
      name,
      user = "channel",
      initialValue = store[name] || {},
      compare = "prevValue !== value",
      pipeline,
      open: url,
      notify: notifyMessage,
      interval = 60,
      delay = 0,
      debug = debugAll,
    } = listener;

    if ((time - delay) % interval !== 0) return;

    const value = (
      await pipeline.reduce(
        async (accPromise, step) => {
          const acc = await accPromise;

          if (/^text:/.test(step)) {
            const url = parseUrl(step.slice(5), acc);
            if (debug) console.log("fetching from: " + url);
            acc.text = await fetch(url).then((r) => r.text());
          } else if (/^json:/.test(step)) {
            const url = parseUrl(step.slice(5), acc);
            if (debug) console.log("fetching from: " + url);
            acc.json = await fetch(url).then((r) => r.json());
          } else if (/^html:/.test(step)) {
            const url = parseUrl(step.slice(5), acc);
            if (debug) console.log("fetching from: " + url);
            acc.html = await fetch(url)
              .then((r) => r.text())
              .then((t) => {
                return new JSDOM(t).window.document;
              });
          } else if (typeof step === "function") {
            acc.value = step(acc);
          } else {
            acc.value = execCode(step, acc);
          }

          return {
            ...acc,
          };
        },
        { text: null, json: null, html: null, value: initialValue }
      )
    ).value;

    const prevValue = store[name] || initialValue;
    const shouldFire = execCode(compare, {
      prevValue,
      value,
    });

    store[name] = value;

    if (shouldFire) {
      let urlLocation = "";
      let title = name + " fikk et varsel";

      if (url) {
        if (typeof url === "function") {
          urlLocation = url(value);
        } else if (typeof url === "string") {
          urlLocation = execCode(
            '"' +
              parseUrl(url, {
                prevValue,
                value,
              }) +
              '"',
            {
              prevValue,
              value,
            }
          );
        }
        if (urlLocation && !isHeadless) open(urlLocation);
      }

      if (notifyMessage) {
        if (typeof notifyMessage === "function") {
          title = notifyMessage(value);
        } else if (typeof notifyMessage === "string") {
          title = execCode(notifyMessage.startsWith("return ") ? notifyMessage : '"' + notifyMessage + '"', {
            prevValue,
            value,
          });
        }
        if (!isHeadless) notifier.notify({ title, sound: true });
      }

      if (slackToken) {
        const userMarkup = user === "channel" ? "!channel" : "@" + slackUsers[user];
        slack.chat.postMessage({
          text: `<${userMarkup}> ${title}${urlLocation ? ": " + urlLocation : ""}`,
          channel: "general",
        });
      }

      console.log(title, urlLocation, new Date());
    }

    if (debug) {
      console.log("compare:", prevValue, "->", value);
      console.log("fire:", shouldFire);
    }
  });

  await Promise.all(processes);

  fs.writeFileSync("./store.json", JSON.stringify(store, null, 2));
};

checkListeners(time);

if (!isFunction) {
  setInterval(() => {
    time += dt;
    checkListeners(time);
  }, dt * 1000);
}
