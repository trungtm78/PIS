<#-- The error page of the public edition. A person lands here, for example, when the cookies of the browser name a session of the provider that no longer works (an
     account that was removed, a session that was ended on the server): the page of Keycloak then says the sign-in failed although nothing was typed. The way out is
     always offered: back to the application, which starts a NEW sign-in (`?signin=fresh` makes the web ask the provider with prompt=login, whatever the cookies say). -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        ${kcSanitize(msg("errorTitle"))?no_esc}
    <#elseif section = "form">
        <div id="kc-error-message">
            <p class="instruction">${kcSanitize(message.summary)?no_esc}</p>
            <#-- The home screen of the application on this host, with the mark that starts a new sign-in. The address names a screen (not "/"): the redirect of the
                 root address would drop the mark. The realm and the application are served by the same host. -->
            <p class="instruction">${msg("pisSignInAgainHint")}</p>
            <p>
                <a id="pis-sign-in-again" class="pf-v5-c-button pf-m-primary pf-m-block" href="/home/home-01?signin=fresh">${msg("pisSignInAgain")}</a>
            </p>
        </div>
    </#if>
</@layout.registrationLayout>
