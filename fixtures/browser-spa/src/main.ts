import * as GetException from "@getexception/browser";

const status = document.querySelector<HTMLElement>("#status")!;

document.querySelector("#connect")!.addEventListener("click", () => {
  GetException.init({
    dsn: document.querySelector<HTMLInputElement>("#dsn")!.value,
    environment: "development",
    release: "browser-fixture@0123456789abcdef0123456789abcdef01234567",
  });
  document.querySelector<HTMLInputElement>("#dsn")!.value = "";
  GetException.setTag("component", "browser-fixture");
  GetException.setContext("app", { route: "/fixture" });
  status.textContent = "Connected";
});
document.querySelector("#handled")!.addEventListener("click", () => {
  GetException.addBreadcrumb({
    category: "manual",
    data: { operation: "fixture-test" },
  });
  GetException.captureException(new Error("Browser fixture error"));
  void GetException.flush().then(() => {
    status.textContent = "Sent";
  });
});
document.querySelector("#unhandled")!.addEventListener("click", () => {
  setTimeout(() => {
    throw new Error("Browser unhandled error");
  }, 0);
});
document.querySelector("#rejection")!.addEventListener("click", () => {
  void Promise.reject(new Error("Browser rejected promise"));
});
