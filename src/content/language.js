  function scriptCharRatio(text, pattern) {
    const characters = [...text].filter((char) => /\S/u.test(char));
    if (characters.length === 0) {
      return 0;
    }
    const matched = characters.filter((char) => pattern.test(char)).length;
    return matched / characters.length;
  }

  function isAlreadyTargetLanguage(text, targetLanguage) {
    const pattern = TARGET_LANGUAGE_SCRIPT_PATTERNS[targetLanguage];
    if (!pattern) {
      return false;
    }
    return scriptCharRatio(text, pattern) >= 0.5;
  }
