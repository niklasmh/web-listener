# Thing to listen to

```yaml
interval: 60
compare: value !== prevValue
open: <url or code returning an url>
notify: <message or code returning a generated message>
```

```fetch
html:<url or code returning an url>
```

```javascript
return parseInt(html.querySelector("#price").innerHTML.replace(/[^\d]/g, ""));
```
