import { FixedClock, SystemClock } from "../../../src/ports/clock";
import { clockContract } from "../../contracts/clock-contract";

clockContract("fixed", () => new FixedClock("2026-08-04T12:00:00.000Z"));
clockContract("system", () => new SystemClock());
