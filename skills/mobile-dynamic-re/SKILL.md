---
name: mobile-dynamic-re
description: >-
  Mobile dynamic reverse engineering with Frida/Substrate. Use when hooking iOS/Android apps at runtime for algorithm extraction, parameter capture, or detection bypass.
---

# SKILL: Mobile Dynamic Reverse Engineering — Frida/Substrate Playbook

> **AI LOAD INSTRUCTION**: Expert dynamic analysis skill for iOS and Android applications using Frida, Substrate, and Xposed. Covers hooking patterns, anti-detection bypass, ObjC/Java runtime manipulation, and network interception. Base models often make critical errors: wrong ObjC Block ABI, incorrect Frida API usage for complex types, and failing to address detection before attempting hooks. This skill provides battle-tested patterns from 300+ real sessions.

## 0. RELATED ROUTING

- [re-router](../re-router/SKILL.md) — re-assess if dynamic analysis is the right approach
- [re-escalation](../re-escalation/SKILL.md) — when hooks repeatedly fail or get detected
- [emulation-re](../emulation-re/SKILL.md) — fallback when device-based analysis is blocked
- [native-static-re](../native-static-re/SKILL.md) — complement dynamic with static analysis
- [anti-debugging-techniques](../anti-debugging-techniques/SKILL.md) — defeat detection layers

## 1. QUICK DECISION — Before You Hook

| Question | If YES | If NO |
|----------|--------|-------|
| Do you have a jailbroken/rooted device? | Proceed with Frida | → emulation-re |
| Does the app detect your environment? | Fix detection FIRST (§4) | Proceed to hook |
| Do you know the target function address? | Direct Interceptor hook | Need discovery first (§2) |
| Is target in ObjC/Java layer? | High-level API (§3) | Native layer hook (§5) |

## 2. TARGET DISCOVERY — Finding What to Hook

### 2.1 iOS Discovery

```javascript
// List all loaded modules
Process.enumerateModules().forEach(m => console.log(m.name, m.base));

// Find ObjC classes matching pattern
ObjC.enumerateLoadedClasses({
  onMatch: (name) => { if (name.includes("Sign")) console.log(name); },
  onComplete: () => {}
});

// List methods of a class
ObjC.classes["ClassName"].$ownMethods.forEach(m => console.log(m));

// Trace all methods of a class
var target = ObjC.classes["TTNetworkManager"];
target.$ownMethods.forEach(function(method) {
  Interceptor.attach(target[method].implementation, {
    onEnter: function(args) { console.log(method, "called"); }
  });
});
```

### 2.2 Android Discovery

```javascript
// List loaded classes matching pattern
Java.perform(function() {
  Java.enumerateLoadedClasses({
    onMatch: function(name) {
      if (name.includes("Sign") || name.includes("Encrypt"))
        console.log(name);
    },
    onComplete: function() {}
  });
});

// Hook all methods of a class
Java.perform(function() {
  var clazz = Java.use("com.example.SignHelper");
  var methods = clazz.class.getDeclaredMethods();
  methods.forEach(function(method) {
    console.log(method.getName());
  });
});
```

### 2.3 Native Symbol Discovery

```javascript
// Find exports matching pattern
Module.enumerateExports("libsecurity.dylib", {
  onMatch: function(exp) {
    if (exp.name.includes("sign") || exp.name.includes("encrypt"))
      console.log(exp.type, exp.name, exp.address);
  },
  onComplete: function() {}
});

// Find by address from IDA
var base = Module.findBaseAddress("AwemeCore");
var targetFunc = base.add(0x1234ABCD); // offset from IDA
```

## 3. iOS HOOKING PATTERNS

### 3.1 ObjC Method Hook (Basic)

```javascript
var hook = ObjC.classes["ClassName"]["- methodName:withArg:"];
Interceptor.attach(hook.implementation, {
  onEnter: function(args) {
    // args[0] = self, args[1] = _cmd, args[2+] = actual params
    var self = new ObjC.Object(args[0]);
    var param1 = new ObjC.Object(args[2]);
    console.log("param1:", param1.toString());
  },
  onLeave: function(retval) {
    var result = new ObjC.Object(retval);
    console.log("return:", result.toString());
  }
});
```

### 3.2 ObjC Block Hook (Critical — Most Common Mistake)

```javascript
// Blocks have a specific ABI layout:
// struct Block {
//   void *isa;           // +0
//   int flags;           // +8
//   int reserved;        // +12
//   void *invoke;        // +16 ← this is the function pointer
//   void *descriptor;    // +24
//   // captured variables follow
// }

function hookBlock(blockPtr, description) {
  var block = new ObjC.Block(blockPtr);
  var origImpl = block.implementation;
  block.implementation = function() {
    console.log(description, "Block invoked with", arguments.length, "args");
    for (var i = 0; i < arguments.length; i++) {
      console.log("  arg[" + i + "]:", arguments[i]);
    }
    var result = origImpl.apply(this, arguments);
    console.log("  result:", result);
    return result;
  };
}

// Usage: hook completion block passed to async method
Interceptor.attach(targetMethod.implementation, {
  onEnter: function(args) {
    hookBlock(args[4], "completion"); // arg index depends on method signature
  }
});
```

### 3.3 Replacing Method Implementation

```javascript
// Replace entire method
var origImpl = ObjC.classes["Target"]["- checkEnvironment"].implementation;
ObjC.classes["Target"]["- checkEnvironment"].implementation = ObjC.implement(
  ObjC.classes["Target"]["- checkEnvironment"], function(handle, selector) {
    // Return NO (0) to bypass check
    return 0;
  }
);
```

### 3.4 NSURLSession / Network Interception (iOS)

```javascript
// Hook dataTaskWithRequest:completionHandler:
var NSURLSession = ObjC.classes["NSURLSession"];
var dataTask = NSURLSession["- dataTaskWithRequest:completionHandler:"];
Interceptor.attach(dataTask.implementation, {
  onEnter: function(args) {
    var request = new ObjC.Object(args[2]);
    console.log("URL:", request.URL().absoluteString().toString());
    console.log("Headers:", request.allHTTPHeaderFields().toString());
    var body = request.HTTPBody();
    if (body) console.log("Body:", body.toString());
    
    // Hook the completion block to capture response
    hookBlock(args[3], "response");
  }
});
```

## 4. ANTI-DETECTION BYPASS (Do This FIRST)

### 4.1 iOS Jailbreak Detection Bypass

Common detection vectors and bypass:

| Detection Method | What It Checks | Bypass |
|-----------------|----------------|--------|
| `fileExistsAtPath:` | /Applications/Cydia.app, /usr/sbin/sshd, etc. | Hook NSFileManager, return NO for blacklisted paths |
| `canOpenURL:` | cydia://, sileo:// | Hook UIApplication, return NO |
| `getenv("DYLD_INSERT_LIBRARIES")` | Injected dylibs | Hook getenv, return NULL for this key |
| `_dyld_image_count()` / `_dyld_get_image_name()` | Enumerate loaded dylibs | Filter out Substrate/Frida from results |
| `sysctl(CTL_KERN, KERN_PROC, ...)` | Check P_TRACED flag | Hook sysctl, clear traced flag |
| `sandbox_check()` | Sandbox escape indicators | Hook and return "sandboxed" |
| `stat("/private/var/lib/apt")` | Apt package manager | Hook stat, return ENOENT |
| `access("/bin/bash", F_OK)` | Shell availability | Hook access, return -1 |
| `fork()` | Process creation (blocked in sandbox) | Hook fork, return -1 |
| `dladdr()` checking caller | Detecting hook frameworks | Hook dladdr, sanitize results |

```javascript
// Comprehensive jailbreak bypass template
["fileExistsAtPath:", "isReadableFileAtPath:"].forEach(function(method) {
  var hook = ObjC.classes.NSFileManager["- " + method];
  Interceptor.attach(hook.implementation, {
    onEnter: function(args) {
      this.path = new ObjC.Object(args[2]).toString();
    },
    onLeave: function(retval) {
      var dominated = ["/Applications/Cydia", "/usr/sbin/sshd", 
        "/private/var/lib/apt", "/usr/bin/ssh", "/private/var/stash",
        "/Library/MobileSubstrate", "/.installed_turing"];
      if (dominated.some(p => this.path.includes(p))) {
        retval.replace(0);
      }
    }
  });
});
```

### 4.2 Frida Detection Bypass

| Detection | Bypass |
|-----------|--------|
| Port scan (27042 default) | Use non-default port: `frida -H device:12345` |
| `/proc/self/maps` scanning for frida-agent | Rename frida-agent or hook open/read |
| Module name check (`frida`, `substrate`) | Hook `_dyld_get_image_name`, filter |
| Thread name scanning | Hook `pthread_getname_np` |
| Inline hook detection (prologue bytes) | Use Stalker instead of Interceptor for stealth |

### 4.3 SSL Pinning Bypass

```javascript
// iOS: bypass common pinning implementations
// AFNetworking / Alamofire
var AFSecurityPolicy = ObjC.classes["AFSecurityPolicy"];
if (AFSecurityPolicy) {
  Interceptor.attach(AFSecurityPolicy["- evaluateServerTrust:forDomain:"].implementation, {
    onLeave: function(retval) { retval.replace(1); }
  });
}

// TrustKit
var TSKPinningValidator = ObjC.classes["TSKPinningValidator"];
if (TSKPinningValidator) {
  Interceptor.attach(TSKPinningValidator["- evaluateTrust:forHostname:"].implementation, {
    onLeave: function(retval) { retval.replace(0); } // 0 = TSKTrustDecisionShouldAllowConnection
  });
}
```

## 5. NATIVE LAYER HOOKING

### 5.1 ARM64 Function Hook

```javascript
// Hook by offset from module base
var module = Process.findModuleByName("libcrypto.dylib");
var funcAddr = module.base.add(0xABCDE);

Interceptor.attach(funcAddr, {
  onEnter: function(args) {
    // ARM64 calling convention: x0-x7 for first 8 args
    console.log("arg0 (buffer):", hexdump(args[0], {length: 64}));
    console.log("arg1 (length):", args[1].toInt32());
    this.outBuf = args[2]; // save for onLeave
  },
  onLeave: function(retval) {
    console.log("output:", hexdump(this.outBuf, {length: 32}));
  }
});
```

### 5.2 Stalker Tracing (Stealth — No Code Modification)

```javascript
// Trace execution without modifying code (avoids integrity checks)
var targetAddr = Module.findBaseAddress("target").add(0x1000);

Stalker.follow(Process.getCurrentThreadId(), {
  transform: function(iterator) {
    var instruction;
    while ((instruction = iterator.next()) !== null) {
      if (instruction.address.equals(targetAddr)) {
        iterator.putCallout(function(context) {
          console.log("Hit target! x0:", context.x0, "x1:", context.x1);
        });
      }
      iterator.keep();
    }
  }
});
```

## 6. ANDROID SPECIFIC PATTERNS

### 6.1 Java Layer Hook

```javascript
Java.perform(function() {
  var SignHelper = Java.use("com.example.app.SignHelper");
  
  // Hook overloaded method
  SignHelper.sign.overload("java.lang.String", "long").implementation = function(data, timestamp) {
    console.log("sign called:", data, timestamp);
    var result = this.sign(data, timestamp);
    console.log("sign result:", result);
    return result;
  };
});
```

### 6.2 JNI Native Method Hook

```javascript
// Hook JNI RegisterNatives to find native method addresses
var RegisterNatives = Module.findExportByName(null, "RegisterNatives");
// Or hook the specific native method after library loads:
Java.perform(function() {
  var System = Java.use("java.lang.System");
  var origLoad = System.loadLibrary.overload("java.lang.String");
  origLoad.implementation = function(lib) {
    origLoad.call(this, lib);
    if (lib === "security") {
      // Now hook the native function
      var nativeSign = Module.findExportByName("libsecurity.so", "Java_com_example_Security_sign");
      Interceptor.attach(nativeSign, { /* ... */ });
    }
  };
});
```

### 6.3 OkHttp Interceptor

```javascript
Java.perform(function() {
  var OkHttpClient = Java.use("okhttp3.OkHttpClient");
  var Builder = Java.use("okhttp3.OkHttpClient$Builder");
  var Interceptor = Java.use("okhttp3.Interceptor");
  
  // Log all requests
  var RealCall = Java.use("okhttp3.internal.connection.RealCall");
  RealCall.getResponseWithInterceptorChain.implementation = function() {
    var request = this.originalRequest.value;
    console.log("URL:", request.url().toString());
    console.log("Headers:", request.headers().toString());
    return this.getResponseWithInterceptorChain();
  };
});
```

## 7. STREAMING & ASYNC RESPONSE CAPTURE

### 7.1 iOS Streaming (Cronet/TTNet)

```javascript
// For streaming responses, hook the delegate methods
var delegateClass = ObjC.classes["YourStreamDelegate"];
Interceptor.attach(delegateClass["- didReceiveData:"].implementation, {
  onEnter: function(args) {
    var data = new ObjC.Object(args[2]);
    var str = data.bytes().readUtf8String(data.length());
    console.log("Stream chunk:", str);
  }
});

// For Cronet bidirectional stream
var CronetStream = ObjC.classes["GRXConcurrentWriteable"];
if (CronetStream) {
  Interceptor.attach(CronetStream["- writeMessage:"].implementation, {
    onEnter: function(args) {
      // Capture streaming response data
    }
  });
}
```

## 8. WORKFLOW — Putting It All Together

### Standard Mobile RE Workflow:

```
1. RECON
   ├── Static: Get binary, check protection (checksec/rabin2/otool)
   ├── Dynamic: Launch with Frida, enumerate modules/classes
   └── Network: Capture traffic with mitmproxy/Charles

2. IDENTIFY TARGET
   ├── Find signing/encryption function (string search, xrefs)
   ├── Identify calling convention and parameters
   └── Map call chain (caller → target → callee)

3. DEFEAT PROTECTION (if any)
   ├── Bypass jailbreak/root detection (§4.1)
   ├── Bypass Frida detection (§4.2)
   ├── Bypass SSL pinning (§4.3)
   └── Verify: app runs normally with hooks active

4. HOOK & CAPTURE
   ├── Hook target function (§3 or §5 or §6)
   ├── Capture inputs and outputs
   ├── Trigger the function (user action or replay request)
   └── Verify: captured data matches expected format

5. VALIDATE
   ├── Compare captured output with traffic capture
   ├── Reproduce: same inputs → same outputs?
   └── Document: function signature, params, algorithm behavior
```

### When This Workflow Fails → Load [re-escalation](../re-escalation/SKILL.md)

## 9. STOP CONDITIONS (specific to dynamic analysis)

| Signal | Action |
|--------|--------|
| App crashes on launch with Frida | Detection active → §4 first |
| Hook fires but always returns nil | Hooked too early or wrong overload → check timing |
| Same approach failed 3 times | → [re-escalation](../re-escalation/SKILL.md) |
| Can't find target function dynamically | → [native-static-re](../native-static-re/SKILL.md) for offline analysis first |
| Device unavailable or unstable | → [emulation-re](../emulation-re/SKILL.md) for offline approach |
