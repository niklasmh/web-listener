import fs from "fs";
import fetch from "node-fetch";
import notifier from "node-notifier";
import CURLParser from "parse-curl";
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

const debugAll = process.env.DEBUG === "true";

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
    const isHTTP = url.startsWith("http://") || url.startsWith("https://");
    const extension = url.split(".").slice(-1)[0].trim();
    if (extension === "json") {
      if (isHTTP) {
        return await fetch(url).then((r) => r.json());
      }
      return JSON.parse(fs.readFileSync("./" + url, "utf8"));
    }
    if (extension === "md") {
      const markdown = isHTTP ? await fetch(url).then((r) => r.text()) : fs.readFileSync("./" + url, "utf8");
      const listenerSections = markdown.split(/^# /gm).slice(1);
      return listenerSections.map((section) => {
        const [name, ...codes] = section.trim().split("```");
        const config = codes
          .find((code) => code.startsWith("yaml"))
          .trim()
          .split("\n")
          .slice(1)
          .reduce((c, item) => {
            let [key, ...value] = item.split(":");
            value = value.join(":").trim();
            if (/^[0-9]+$/.test(value)) {
              value = parseInt(value);
            } else if (/^(true|false)$/.test(value)) {
              value = value === "true";
            }
            return {
              ...c,
              [key]: value,
            };
          }, {});
        const pipeline = codes
          .filter((code) => code.startsWith("javascript") || code.startsWith("fetch") || code.startsWith("curl"))
          .map((code) => {
            let [codeInfo, ...codeBlock] = code.trim().split("\n");
            codeBlock = codeBlock.join("\n");
            let [codeType, ...metadata] = codeInfo.split(" ");
            metadata = metadata.join(" ");
            return {
              codeType,
              metadata,
              code: codeBlock,
            };
          });
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
  try {
    return {
      value: new Function(`
const date = (time, delimiter = "-") => {
  const date = new Date(time);
  const dd = (d) => (d < 10 ? "0" + d : d);
  const year = date.getFullYear();
  const month = dd(date.getMonth() + 1);
  const day = dd(date.getDate());
  return year + delimiter + month + delimiter + day;
}
const dateTime = (time) => {
  const date = new Date(time);
  const dd = (d) => (d < 10 ? "0" + d : d);
  const year = date.getFullYear();
  const month = dd(date.getMonth() + 1);
  const day = dd(date.getDate());
  const hours = dd(date.getHours());
  const minutes = dd(date.getMinutes());
  const seconds = dd(date.getSeconds());
  return year + "-" + month + "-" + day + " " + hours + ":" + minutes + ":" + seconds;
}
with(this) {
  with(this.value || {}) {
    ${code}
  }
}`).bind(state)(),
    };
  } catch (error) {
    return { error, value: "error" };
  }
};

const parseUrl = (url, state) => {
  if (url.startsWith('"') || url.startsWith("'") || url.includes("return ")) {
    const { value, error } = execCode(url, state);
    if (error) {
      return false;
      console.log("url parsing failed:", error);
    } else {
      return value;
    }
  }
  return url;
};

const getHeaders = (lines) => {
  return lines.header
    .map((header) => {
      const [name, ...value] = header.split(":");
      return [name, value.join(":").trim()];
    })
    .reduce((acc, [name, value]) => ({ ...acc, [name]: value }), {});
};

const getMethod = (lines) => {
  return lines.method ? lines.method[0].toUpperCase() : "GET";
};

const getUrl = (lines, fetchType) => {
  return lines[fetchType] ? lines[fetchType][0] : "";
};

const parseFetch = (lines, fetchType, state) => ({
  url: parseUrl(getUrl(lines, fetchType), state),
  headers: getHeaders(lines),
  method: getMethod(lines),
});

const injectCodeInCURL = (curl, state) => {
  return curl.split(/({{|}})/).reduce((string, content, i) => {
    switch (i % 4) {
      case 0:
        return string + content;
      case 1:
        return string;
      case 2:
        return string + execCode(content, state).value;
      case 3:
        return string;
    }
  }, "");
};

const parseCURL = (curl, state) => {
  const generatedCURL = injectCodeInCURL(curl, state);
  //console.log(generatedCURL);
  const { url, header, method } = CURLParser(generatedCURL);
  return {
    url,
    headers: header,
    method,
  };
};

const checkListeners = async (time) => {
  const processes = listeners.map(async (listener) => {
    const {
      name,
      user = "channel",
      initialValue = store[name] || null,
      compare = "prevValue !== value",
      pipeline,
      open: url,
      notify: notifyMessage,
      interval = 60,
      delay = 0,
      debug = debugAll,
    } = listener;

    if ((time - delay) % interval !== 0) return;

    let stopProcess = false;

    const value = (
      await pipeline.reduce(
        async (statePromise, { code, codeType, metadata = "text" }) => {
          const state = await statePromise;

          if (stopProcess) {
            console.log("stopping pipeline for", name);
            return statePromise;
          }

          if (/^(fetch|curl)$/.test(codeType)) {
            const lines = code.split("\n").reduce((acc, n) => {
              let [key, ...value] = n.split(":");
              key = key.trim();
              value = value.join(":").trim();
              return { ...acc, [key]: key in acc ? [...acc[key], value] : [value] };
            }, {});
            const fetchType = metadata.slice(0, 4);

            const { url, method, headers } =
              codeType === "curl" ? parseCURL(code, state) : parseFetch(lines, fetchType, state);

            const requestOptions = {
              headers,
              method,
            };

            if (!url) {
              console.log("cannot parse url:", code);
            } else {
              if (debug) console.log("fetching from: " + url);
              try {
                const handleStatusCode = async (r) => {
                  if (r.status >= 200 && r.status < 400) {
                    return r;
                  }
                  throw new Error(await r.text());
                };
                switch (fetchType) {
                  case "text":
                    state.text = await fetch(url, requestOptions)
                      .then(handleStatusCode)
                      .then((r) => r.text());
                    break;
                  case "json":
                    state.json = await fetch(url, requestOptions)
                      .then(handleStatusCode)
                      .then((r) => r.json());
                    break;
                  case "html":
                    state.html = await fetch(url, requestOptions)
                      .then(handleStatusCode)
                      .then((r) => r.text())
                      .then((t) => new JSDOM(t).window.document);
                    break;
                }
              } catch (error) {
                state.error = error.message;
                console.log("failed to fetch:", error.message);
              }
            }
          } else {
            if (typeof code === "function") {
              state.value = code(state);
              if (debug) console.log("value:", state.value);
            } else {
              const { value, error } = execCode(code, state);
              if (error) {
                console.log(name, "failed executing code block:", error);
              } else {
                state.value = value;
                if (debug) console.log("value:", value);
              }
            }
          }

          return {
            ...state,
          };
        },
        {
          text: null,
          json: null,
          html: null,
          error: null,
          exit: () => {
            stopProcess = true;
            return "exit";
          },
          value: initialValue,
        }
      )
    ).value;

    if (stopProcess) {
      return;
    }

    let prevValue = store[name] || initialValue;
    if (prevValue === null) {
      switch (typeof value) {
        case "number":
          prevValue = 0;
          break;
        case "boolean":
          prevValue = false;
          break;
        case "string":
          prevValue = "";
          break;
        case "object":
        default:
          prevValue = {};
          break;
      }
    }

    const shouldFire = execCode(compare, {
      prevValue,
      value,
    }).value;

    store[name] = value;

    if (shouldFire) {
      let urlLocation = "";
      let message = name + " got a notification";

      if (url) {
        if (typeof url === "function") {
          urlLocation = url(value);
        } else if (typeof url === "string") {
          const { value: urlLocationValue, error } = execCode(
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
          if (error) {
            urlLocation = "";
            console.log("open url failed:", error);
          } else {
            urlLocation = urlLocationValue;
          }
        }
        if (urlLocation && !isHeadless) open(urlLocation);
      }

      if (notifyMessage) {
        if (typeof notifyMessage === "function") {
          message = notifyMessage(value);
        } else if (typeof notifyMessage === "string") {
          const { value: notifyValue, error } = execCode(
            notifyMessage.startsWith("return ") || notifyMessage.startsWith('"') || notifyMessage.startsWith("'")
              ? notifyMessage
              : '"' + notifyMessage + '"',
            {
              prevValue,
              value,
            }
          );
          if (error) {
            message = "error:" + error;
            console.log("notify failed:", error);
          } else {
            message = notifyValue;
          }
        }
        if (!isHeadless) notifier.notify({ title: message, sound: true });
      }

      if (slackToken) {
        const userMarkup = user === "channel" ? "!channel" : "@" + slackUsers[user];
        slack.chat.postMessage({
          text: urlLocation ? `<${userMarkup}> ${message}: ${urlLocation}` : `<${userMarkup}> ${message}`,
          channel: "general",
        });
      }

      console.log(message, urlLocation, new Date());
    }

    if (debug) {
      console.log("compare:", prevValue, "->", value, "(" + name + ")");
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
