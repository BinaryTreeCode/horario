<script>
  import { initDB } from "../lib/db";
  
  // Single entry point for initialization
  if (typeof window !== "undefined") {
    initDB().catch(console.error);
  }
</script>
